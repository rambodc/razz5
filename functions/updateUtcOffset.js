const admin = require('firebase-admin');

module.exports = async function updateUtcOffset(documentId, params) {
    const { utcOffset } = params;

    try {
        // Get the functionCalls document
        const functionCallRef = admin.firestore().collection('functionCalls').doc(documentId);
        const functionCallDoc = await functionCallRef.get();

        if (!functionCallDoc.exists) {
            throw new Error('functionCalls document does not exist.');
        }

        // Extract the UID from the functionCalls document
        const uid = functionCallDoc.data().uid;

        if (!uid) {
            throw new Error('UID is missing in functionCalls document.');
        }

        // Reference to the user's document in the users collection
        const userRef = admin.firestore().collection('users').doc(uid);

        // Update the utcOffset field in the user's document
        await userRef.update({ utcOffset });

        // Update the functionCalls document with the completion status
        await functionCallRef.update({
            'status': 'completed',
            'response.result': 'success',
            'response.data.utcOffset': utcOffset,
            'response.completed': admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (error) {
        console.error(`Error in updateUtcOffset function: ${error.message}`);

        // Update the functionCalls document with the error status
        await admin.firestore().collection('functionCalls').doc(documentId).update({
            'status': 'error',
            'response.errorMessage': error.message,
            'response.error': admin.firestore.FieldValue.serverTimestamp()
        });
    }
};
