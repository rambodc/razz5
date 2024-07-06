const admin = require('firebase-admin');

module.exports = async function updateUtcOffset(documentId, params) {
    const { utcOffset } = params;

    const functionCallRef = admin.firestore().collection('functionCalls').doc(documentId);

    try {
        // Run the entire operation in a Firestore transaction
        await admin.firestore().runTransaction(async (transaction) => {
            // Get the functionCalls document
            const functionCallDoc = await transaction.get(functionCallRef);

            if (!functionCallDoc.exists) {
                throw new Error('functionCalls document does not exist.');
            }

            // Extract the UID from the functionCalls document
            const functionCallData = functionCallDoc.data();
            const uid = functionCallData.uid;

            if (!uid) {
                throw new Error('UID is missing in functionCalls document.');
            }

            if (functionCallData.status === 'processing') {
                throw new Error('This function call is already being processed.');
            }

            // Mark the function call as processing
            transaction.update(functionCallRef, {
                'status': 'processing'
            });

            // Reference to the user's document in the users collection
            const userRef = admin.firestore().collection('users').doc(uid);

            // Update the utcOffset field in the user's document
            transaction.update(userRef, { utcOffset });

            // Update the functionCalls document with the completion status
            transaction.update(functionCallRef, {
                'status': 'completed',
                'response.result': 'success',
                'response.data.utcOffset': utcOffset,
                'response.completed': admin.firestore.FieldValue.serverTimestamp()
            });
        });
    } catch (error) {
        console.error(`Error in updateUtcOffset function: ${error.message}`);

        let status = 'error';
        let errorMessage = error.message;

        if (error.message.includes('already being processed')) {
            status = 'concurrencyError';
            errorMessage = 'Function call hit concurrency issue';
        }

        // Update the functionCalls document with the error or concurrencyError status
        await functionCallRef.update({
            'status': status,
            'response.errorMessage': errorMessage,
            'response.error': admin.firestore.FieldValue.serverTimestamp()
        });
    }
};
