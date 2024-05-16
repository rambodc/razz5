const admin = require('firebase-admin');

module.exports = async function transactions(documentId, params) {
    const { uid, txnType, collectionName, collectionDocId, expiryHours, currency, amount, collectedAmount, collectedCurrency, description, metadata } = params;

    try {
        const now = new Date();

        // Generate an expiry date by adding expiryHours to the current time
        const expiryDate = new Date(now.getTime() + expiryHours * 60 * 60 * 1000);

        // Generate a new document ID
        const txnRef = admin.firestore().collection('transactions').doc();

        const txnId = txnRef.id;  // ID of the transaction document

        // Save transaction details in Firestore
        await txnRef.set({
            uid,
            txnType,
            collectionName,
            collectionDocId,
            createdDate: now,
            expiryDate,
            currency,
            amount,
            uploadedToBigQuery: false,  // Default value
            collectedAmount,
            collectedCurrency,
            description,
            metadata,  // Include metadata object
            txnId,
        });

        // Update the status of the function call
        await admin.firestore().collection('functionCalls').doc(documentId).update({
            'status': 'completed',
            'response.result': 'success',
            'response.data.txnId': txnId,
            'response.completed': admin.firestore.FieldValue.serverTimestamp()
        });

    } catch (error) {
        console.error(`Error in transactions function: ${error}`);

        await admin.firestore().collection('functionCalls').doc(documentId).update({
            'status': 'error',
            'response.errorMessage': error.message,
            'response.error': admin.firestore.FieldValue.serverTimestamp()
        });
    }
};

