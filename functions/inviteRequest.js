const admin = require('firebase-admin');

module.exports = async function inviteRequest(documentId, params) {
    const inviteRef = admin.firestore().collection('invites').doc(documentId);

    // Extract parameters for easier access
    const {
        inviter,
        invitee,
        inviteeExists,
        type,
        description,
        expiresAt,
        createdAt,
        rejectedAt,
        acceptedAt,
        accepted,
        rejected
    } = params;

    try {
        // Prepare the invite document data, including the documentId as inviteId
        const inviteData = {
            inviteId: documentId, // Include the document ID as inviteId
            inviter,
            invitee,
            inviteeExists,
            type,
            description,
            expiresAt,
            createdAt,
            rejectedAt,
            acceptedAt,
            accepted,
            rejected
        };

        // Set the invite data in Firestore
        await inviteRef.set(inviteData);

        // Update the functionCalls document with the result, including the inviteId
        await admin.firestore().collection('functionCalls').doc(documentId).update({
            'status': 'completed',
            'response.result': 'success',
            'response.data': { ...inviteData, inviteId: documentId }, // Return the inviteId in the response data
            'response.completed': admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (error) {
        console.error(`Error while processing invite request: ${error}`);

        // Update the functionCalls document with the error
        await admin.firestore().collection('functionCalls').doc(documentId).update({
            'status': 'error',
            'response.errorMessage': error.message,
            'response.error': admin.firestore.FieldValue.serverTimestamp()
        });
    }
};
