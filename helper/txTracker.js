const fs = require('fs');
const path = require('path');

const TX_LOG_PATH = path.join(__dirname, 'processedTransactions.json');

// Initialize file if doesn't exist
if (!fs.existsSync(TX_LOG_PATH)) {
    fs.writeFileSync(TX_LOG_PATH, JSON.stringify([]));
}

function getProcessedTransactions() {
    return JSON.parse(fs.readFileSync(TX_LOG_PATH));
}

function addProcessedTransaction(txid, amount) {
    const txns = getProcessedTransactions();
    txns.push({ 
        txid, 
        amount, 
        processedAt: new Date().toISOString() 
    });
    fs.writeFileSync(TX_LOG_PATH, JSON.stringify(txns, null, 2));
}

function isTransactionProcessed(txid) {
    return getProcessedTransactions().some(tx => tx.txid === txid);
}

module.exports = {
    getProcessedTransactions,
    addProcessedTransaction,
    isTransactionProcessed
};