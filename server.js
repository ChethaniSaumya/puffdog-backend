require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults');
const { keypairIdentity, publicKey, transactionBuilder, generateSigner } = require('@metaplex-foundation/umi');
const { mplTokenMetadata, createNft } = require('@metaplex-foundation/mpl-token-metadata');
const { setComputeUnitLimit } = require('@metaplex-foundation/mpl-toolbox');
const { Connection, SystemProgram, PublicKey, LAMPORTS_PER_SOL, Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const { publicKey: UMIPublicKey, percentAmount } = require('@metaplex-foundation/umi');
const path = require('path');
const bodyParser = require('body-parser');
const axios = require('axios');
const helmet = require('helmet');
const upload = require('express-fileupload');
const morgan = require('morgan');
const txTracker = require('./helper/txTracker');

const {
  createTree,
  mplBubblegum,
  fetchMerkleTree,
  fetchTreeConfigFromSeeds,
  verifyCollection,
  TokenProgramVersion,
  getAssetWithProof,
  findLeafAssetIdPda,
  LeafSchema,
  mintToCollectionV1,
  parseLeafFromMintToCollectionV1Transaction,
  setAndVerifyCollection
} = require('@metaplex-foundation/mpl-bubblegum');

// Create the Express app
const app = express();

// Environment variables
const preQuicknodeEndpoint1 = process.env.HELIUS_RPC1;
const preQuicknodeEndpoint2 = process.env.HELIUS_RPC2;
const pricePerNFT = process.env.AMOUNT;
const merkleTreeLink = UMIPublicKey(process.env.MERKLE_TREE);
const collectionMint = UMIPublicKey(process.env.TOKEN_ADDRESS);

const MAX_SUPPLY = 10000;

// Store connected SSE clients
const clients = [];

// Configure middleware
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// CORS setup
const corsOptions = {
  origin: [''], // your frontend domain
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true, // if your frontend needs cookies or auth
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
//app.options('*', cors(corsOptions));

// Security and utility middleware
app.use(helmet());
app.use(upload());
app.use(morgan('combined'));

// SSE endpoint
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(': Connected\n\n');
  clients.push(res);

  req.on('close', () => {
    clients.splice(clients.indexOf(res), 1);
  });
});

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://pffdog-frontend.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});


// Health check endpoint
app.get('/api/', (req, res) => {
  console.log("Health check successful");
  res.send('successful');
});



/*

PRIVATE KEY SECTION

-----------------------------------------

    const string_key = process.env.STRING_KEY;

-----------------------------------------


function convertPrivateKey(base58PrivateKey) {
    // Decode the base58 private key to get the raw bytes
    const secretKey = bs58.decode(base58PrivateKey);

    // Create a keypair from the secret key
    const keypair = Keypair.fromSecretKey(secretKey);

    // Get the full keypair bytes (secret key + public key)
    const fullKeypair = new Uint8Array([...keypair.secretKey]);

    return Uint8Array.from(Array.from(fullKeypair));
}

-----------------------------------------

    const keyUsing = convertPrivateKey(string_key);
    const myPrivateKey = Uint8Array.from(Array.from(keyUsing));

-----------------------------------------

    const umiKeypairz = {
        publicKey: UMIPublicKey(myPrivateKey.slice(32, 64)), // Extract public key from the secret key
        secretKey: myPrivateKey
    };

-----------------------------------------


*/




// Setup Solana/UMI
const string_key = process.env.STRING_KEY;

 const privateKey = convertPrivateKey(string_key)


function convertPrivateKey(base58PrivateKey) {


  // Decode the base58 private key to get the raw bytes
  const secretKey = bs58.decode(base58PrivateKey);

  // Create a keypair from the secret key
  const keypair = Keypair.fromSecretKey(secretKey);

  // Get the full keypair bytes (secret key + public key)
  const fullKeypair = new Uint8Array([...keypair.secretKey]);
  //console.log("Extracted KKKK ---- :" + Uint8Array.from(Array.from(fullKeypair)))
  return Uint8Array.from(Array.from(fullKeypair));
}


const umiKeypairz = {
  publicKey: UMIPublicKey(privateKey.slice(32, 64)),
  secretKey: privateKey
};

const quicknodeEndpoint = `${preQuicknodeEndpoint1}?api-key=${preQuicknodeEndpoint2}`;

const umi = createUmi(quicknodeEndpoint)
  .use(keypairIdentity(umiKeypairz))
  .use(mplTokenMetadata())
  .use(mplBubblegum());

// Helper function to get current mint count
async function getCurrentMintCount() {
  try {
    const treeAccount = await fetchMerkleTree(umi, merkleTreeLink);
    const currentCount = Number(treeAccount.tree.sequenceNumber);
    console.log("currentCount:", currentCount);
    return currentCount;
  } catch (error) {
    console.error("Error fetching mint count:", error);
    throw error;
  }
}

const merkleTreeSigner = generateSigner(umi);

async function getTransactionAmount(txSignature) {
  const connection = new Connection(quicknodeEndpoint); // Use your RPC endpoint

  // Fetch the transaction
  const tx = await connection.getTransaction(txSignature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  if (!tx) {
    throw new Error('Transaction not found');
  }

  // Extract pre & post balances to compute the transfer amount
  const accountKeys = tx.transaction.message.accountKeys;
  const preBalances = tx.meta.preBalances;
  const postBalances = tx.meta.postBalances;

  // The sender is usually the first account (fee payer)
  const sender = accountKeys[0].toString();
  const senderPreBalance = preBalances[0];
  const senderPostBalance = postBalances[0];

  // The amount sent is the difference minus fees
  const fee = tx.meta.fee;
  const amountLamports = senderPreBalance - senderPostBalance - fee;
  const amountSOL = amountLamports / LAMPORTS_PER_SOL;

  return amountSOL;
}

// Mint endpoint
app.post('/api/mint', async (req, res) => {
  try {
    const { userWallet, paymentSignature } = req.body;

    const amount = await getTransactionAmount(paymentSignature);
    console.log(`Payment amount: ${amount} SOL`);

    if((amount*LAMPORTS_PER_SOL) != pricePerNFT){
      return res.status(409).json({
        success: false,
        error: {
          code: 'Not Enough Funds',
          message: 'Not enough amount sent',
          txid: paymentSignature,
          timestamp: new Date().toISOString(),
          resolution: 'Use our official website'
        }
      });
    }

    console.log("Received mint request:", { userWallet, paymentSignature });

    
    if (txTracker.isTransactionProcessed(paymentSignature)) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'DUPLICATE_TRANSACTION',
          message: 'This transaction ID has already been used',
          txid: paymentSignature,
          timestamp: new Date().toISOString(),
          resolution: 'Please use a new, unique transaction'
        }
      });
    }

    try {
      const txnData = await getWalletAddressesFromTransaction(paymentSignature);
      console.log('Transaction data verified');
    } catch (err) {
      console.error('Failed to verify transaction:', err);
      return res.status(400).json({
        success: false,
        error: {
          code: 'TRANSACTION_VERIFICATION_FAILED',
          message: 'Could not verify the payment transaction',
          details: err.message
        }
      });
    }
    const nftNumber = await getCurrentMintCount();

    try {
      if (nftNumber >= 10000) {
        console.error('Max supply reached');
        return res.status(410).json({
          success: false,
          error: {
            code: 'Limit Reached',
            message: 'This transaction ID has already been used',
            txid: paymentSignature,
            timestamp: new Date().toISOString(),
            resolution: 'Contact admin for the refund'
          }
        });
      }

    } catch (err) {
      console.log(err);
    }

    // NFT MINTING PROCESS
    const nftName = `PUFF DOG #${nftNumber.toString().padStart(4, '0')}`;

    console.log(`Minting NFT: ${nftName} (${nftNumber})`);

    const uintSig = await transactionBuilder()
      .add(setComputeUnitLimit(umi, { units: 800_000 }))
      .add(await mintToCollectionV1(umi, {
        leafOwner: publicKey(userWallet),
        merkleTree: merkleTreeLink,
        collectionMint: collectionMint,
        metadata: {
          name: nftName,
          uri: `https://peach-binding-gamefowl-763.mypinata.cloud/ipfs/bafybeiby6jda3blcbvpizf6hxk5wjzmfsx5x3z6xiqz7sfim3i2ciayjoy/${nftNumber}.json`,
          sellerFeeBasisPoints: 500,
          collection: {
            key: collectionMint,
            verified: true
          },
          creators: [{
            address: umi.identity.publicKey,
            verified: true,
            share: 100
          }],
        },
      }));

    const { signature: mintSignature } = await uintSig.sendAndConfirm(umi, {
      confirm: { commitment: "finalized" },
      send: {
        skipPreflight: true,
      }
    });

    const leaf = await parseLeafFromMintToCollectionV1Transaction(
      umi,
      mintSignature
    );

    const assetId = findLeafAssetIdPda(umi, {
      merkleTree: merkleTreeLink,
      leafIndex: leaf.nonce,
    })[0];

    console.log("NFT minted successfully:", {
      nftNumber,
      userWallet,
      mintSignature: mintSignature
    });

    txTracker.addProcessedTransaction(paymentSignature);

    res.json({
      success: true,
      nftId: assetId,
      imageUrl: `https://peach-binding-gamefowl-763.mypinata.cloud/ipfs/QmY2PNF1rB6k4inLZMUqrt17cH9wpzXqgZ1fFv64SqYcxG/${nftNumber}.png`,
      name: nftName,
      details: {
        paymentVerification: {
          sender: userWallet,
          recipient: umi.identity.publicKey,
          amount: LAMPORTS_PER_SOL * pricePerNFT,
          transactionId: mintSignature
        }
      }
    });
  } catch (error) {
    console.error('Mint error:', {
      error: error.message,
      stack: error.stack,
      body: req.body
    });

    res.status(500).json({
      success: false,
      error: error.message || 'Mint failed',
      details: error.details || null
    });
  }
});

app.post('/api/createMerkleTree', async (req, res) => {
  try {
    const builder = await createTree(umi, {
      merkleTree: merkleTreeSigner,
      maxDepth: 14,
      maxBufferSize: 64,
      public: false
    });

    await builder.sendAndConfirm(umi);

    // Store values globally
    treeCreator = umi.identity.publicKey.toString();
    treeSigner = merkleTreeSigner;
    treeAddress = merkleTreeSigner.publicKey.toString();

    console.log("Tree Creator:", treeCreator);
    console.log("Tree Signer:", treeSigner.publicKey.toString());
    console.log("Tree Address:", treeAddress);

    res.json({
      success: true,
      treeCreator: treeCreator,
      treeSigner: treeSigner,
      treeAddress: treeAddress
    });

  } catch (error) {
    console.error("Error creating Merkle Tree:", error);
  }
});

app.post('/api/createCollection', async (req, res) => {
  try {
    if (!umi) {
      return res.status(500).json({
        success: false,
        error: "UMI not initialized. Check environment variables."
      });
    }

    const collectionMint = generateSigner(umi);

    const response = await createNft(umi, {
      mint: collectionMint,
      name: `PUFF DOG Collection`,
      uri: 'https://peach-binding-gamefowl-763.mypinata.cloud/ipfs/bafkreierqb7ckouxee3wvmbj5madkzo5dj524eakn3zvzsovqtu2noggkq',
      sellerFeeBasisPoints: percentAmount(0),
      isCollection: true,
      updateAuthority: umi.identity,
    }).sendAndConfirm(umi);

    // Get the mint address (public key) of the collection
    const collectionMintAddress = collectionMint.publicKey.toString();

    // Handle signature conversion
    let signature;
    try {
      if (response.signature) {
        if (typeof response.signature === 'object' && response.signature !== null) {
          if (typeof response.signature.toString === 'function') {
            signature = response.signature.toString();
          } else {
            signature = bs58.encode(Buffer.from(response.signature));
          }
        } else {
          signature = String(response.signature);
        }
      } else {
        signature = 'Signature not available';
      }
    } catch (error) {
      console.error("Error converting signature:", error);
      signature = 'Error converting signature';
    }

    console.log("Collection created successfully:", {
      collectionMint: collectionMintAddress,
      transactionSignature: signature
    });

    res.json({
      success: true,
      collectionMint: collectionMintAddress,
      transactionSignature: signature
    });

  } catch (error) {
    console.error("Error creating collection:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create collection'
    });
  }
});

app.post('/api/mintToCollection', async (req, res) => {
  try {
    const uintSig = await transactionBuilder()
      .add(setComputeUnitLimit(umi, { units: 800_000 }))
      .add(await mintToCollectionV1(umi, {
        leafOwner: umi.identity.publicKey,
        merkleTree: merkleTreeLink,
        collectionMint: collectionMint, // This is your collection mint address
        metadata: {
          name: "PUFF DOG Collection",
          uri: "https://peach-binding-gamefowl-763.mypinata.cloud/ipfs/bafkreierqb7ckouxee3wvmbj5madkzo5dj524eakn3zvzsovqtu2noggkq",
          sellerFeeBasisPoints: 0,
          collection: { key: collectionMint, verified: true },
          creators: [
            { address: umi.identity.publicKey, verified: true, share: 100 },
          ],
        },
      }));

    const { signature } = await uintSig.sendAndConfirm(umi, {
      confirm: { commitment: "finalized" },
    });

    /*const txid = bs58.encode(Buffer.from(signature));
    const leaf = await parseLeafFromMintToCollectionV1Transaction(umi, signature);

    // Get the asset ID (equivalent to mint address for cNFTs)
    const assetId = findLeafAssetIdPda(umi, {
      merkleTree: merkleTreeLink,
      leafIndex: leaf.nonce,
    })[0];

    // Get the asset details
    const rpcAsset = await umi.rpc.getAsset(assetId);

    res.json({
      success: true,
      collectionMint: collectionMint.toString(), // The collection mint address
      nft: {
        assetId: assetId.toString(), // The cNFT identifier (similar to mint address)
        txid: txid, // Transaction ID
        leafIndex: leaf.nonce, // Position in the merkle tree
        metadataUri: rpcAsset.content.json_uri, // NFT metadata URI
        owner: rpcAsset.ownership.owner, // Current owner
        // Include any other relevant details from rpcAsset
      }
    });
*/

    console.log("signature : " + signature);

    res.json({
      success: true,
      signature: signature
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Minting failed'
    });
  }
});


// Helper function to get wallet addresses from transaction
async function getWalletAddressesFromTransaction(txnId) {
  try {
    const rpcUrl = 'https://api.devnet.solana.com';

    const response = await axios.post(rpcUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [
        txnId,
        {
          encoding: 'jsonParsed',
          commitment: 'confirmed'
        }
      ]
    });

    if (response.data.error) {
      throw new Error(response.data.error.message);
    }

    const transaction = response.data.result;

    if (!transaction) {
      throw new Error('Transaction not found');
    }

    // Extract account information
    const accountKeys = transaction.transaction.message.accountKeys;

    // Get signer addresses
    const signers = accountKeys
      .filter(account => account.signer)
      .map(account => account.pubkey);

    // Get writable addresses
    const writableAccounts = accountKeys
      .filter(account => account.writable)
      .map(account => account.pubkey);

    return {
      allAddresses: accountKeys.map(account => account.pubkey),
      signers: signers,
      writableAccounts: writableAccounts,
      feePayer: accountKeys[0].pubkey,
      meta: transaction.meta
    };
  } catch (error) {
    console.error('Error fetching transaction:', error.message);
    throw error;
  }
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start the server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
