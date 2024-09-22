const admin = require('firebase-admin');

module.exports = async function updatePostTxn(documentId, params) {
    const { txnHash, status, txnId, postId } = params;

    const txnDocRef = admin.firestore().collection('transactions').doc(txnId);
    const postDocRef = admin.firestore().collection('posts').doc(postId);
    const functionCallDocRef = admin.firestore().collection('functionCalls').doc(documentId);

    try {
        console.log(`Starting transaction for documentId: ${documentId}`);

        // Get the server timestamp
        const serverTimestamp = admin.firestore.Timestamp.now();

        // Run the entire operation in a Firestore transaction
        await admin.firestore().runTransaction(async (transaction) => {
            console.log(`Reading functionCalls document for documentId: ${documentId}`);

            // Retrieve the functionCalls document to get the top-level uid
            const functionCallDoc = await transaction.get(functionCallDocRef);
            const functionCallData = functionCallDoc.data();

            if (functionCallData.status === 'processing') {
                throw new Error('This function call is already being processed.');
            }

            // Step 1: Mark the function call as processing
            transaction.update(functionCallDocRef, {
                'status': 'processing'
            });

            // Step 2: Update the transaction document with the txnHash and status
            console.log(`Updating transaction document for txnId: ${txnId}`);
            transaction.update(txnDocRef, {
                txnHash: txnHash,
                status: status,
                txnHashUpdatedAt: serverTimestamp
            });

            // Step 3: Update the post document with the txnHash
            console.log(`Updating post document for postId: ${postId}`);
            transaction.update(postDocRef, {
                txnHash: txnHash,
                txnHashUpdatedAt: serverTimestamp
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
        console.error(`Error in updatePostTxn function for documentId: ${documentId}: ${error.message}`);

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
