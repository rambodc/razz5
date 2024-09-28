const admin = require('firebase-admin');

module.exports = async function updateFeedTxnCreator(documentId, params) {
    const { txnHash, status, txnId } = params;

    const txnDocRef = admin.firestore().collection('transactions').doc(txnId);
    const functionCallDocRef = admin.firestore().collection('functionCalls').doc(documentId);

    try {
        console.log(`Starting transaction for documentId: ${documentId}`);

        // Get the server timestamp
        const serverTimestamp = admin.firestore.Timestamp.now();

        // Run the entire operation in a Firestore transaction
        await admin.firestore().runTransaction(async (transaction) => {
            console.log(`Reading functionCalls and transaction documents for documentId: ${documentId}`);

            // Perform all reads first
            const functionCallDoc = await transaction.get(functionCallDocRef);
            const txnDoc = await transaction.get(txnDocRef);

            // Check if functionCallDoc exists
            if (!functionCallDoc.exists) {
                throw new Error('functionCalls document does not exist.');
            }

            const functionCallData = functionCallDoc.data();

            if (functionCallData.status === 'processing') {
                throw new Error('This function call is already being processed.');
            }

            // Ensure the txnDoc exists
            if (!txnDoc.exists) {
                throw new Error('Transaction document does not exist.');
            }

            const txnData = txnDoc.data();

            // Step 1: Mark the function call as processing
            transaction.update(functionCallDocRef, {
                'status': 'processing'
            });

            // Step 2: Update the transaction document by adding xrpl object inside the receivers array for type "postCreator"
            const updatedReceivers = txnData.receivers.map(receiver => {
                if (receiver.type === 'postCreator') {
                    return {
                        ...receiver,
                        xrpl: {
                            txnHash: txnHash,
                            status: status,
                            timestamp: serverTimestamp
                        }
                    };
                }
                return receiver;
            });

            // Step 3: Update the transaction document with the modified receivers array and set status to completed
            transaction.update(txnDocRef, {
                receivers: updatedReceivers,
                status: 'completed' // Update main level status to "completed"
            });

            // Step 4: Mark the function call as completed
            transaction.update(functionCallDocRef, {
                'status': 'completed',
                'response.result': 'success',
                'response.data': { txnHash, status },
                'response.completed': serverTimestamp
            });

            console.log(`Transaction completed successfully for documentId: ${documentId}`);
        });

    } catch (error) {
        console.error(`Error in updateFeedTxnCreator function for documentId: ${documentId}: ${error.message}`);

        let status = 'error';
        let errorMessage = error.message;

        if (error.message.includes('already being processed')) {
            status = 'concurrencyError';
            errorMessage = 'Function call hit concurrency issue';
        }

        // Update function call status to error or concurrencyError
        await functionCallDocRef.update({
            'status': status,
            'response.errorMessage': errorMessage,
            'response.error': admin.firestore.FieldValue.serverTimestamp()
        });
    }
};
