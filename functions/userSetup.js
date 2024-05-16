const admin = require('firebase-admin');

module.exports = async function userSetup(documentId, params) {
    const { uid, firstName, lastName, email, userType, userStatus, emailVerified } = params;
    const userRef = admin.firestore().collection('users').doc(uid);

    try {
        const userDoc = await userRef.get();
        if (userDoc.exists) {
            throw new Error('User already exists.');
        }

        const batch = admin.firestore().batch();

        // Set user document
        batch.set(userRef, {
            uid,
            firstName,
            lastName,
            email,
            userType,
            userStatus,
            emailVerified: emailVerified === 'true'
        }, { merge: true });

        // Create conversation document and subcollection chats
        const conversationRef = admin.firestore().collection('conversation').doc(uid);
        batch.set(conversationRef, {}, { merge: true });
        const chatsRef = conversationRef.collection('chats').doc();
        batch.set(chatsRef, {}, { merge: true });

        // Create usersRecent document
        const usersRecentRef = admin.firestore().collection('usersRecent').doc(uid);
        batch.set(usersRecentRef, {
            uid,
            firstName,
            lastName
        }, { merge: true });

        // Commit the batch
        await batch.commit();

        await admin.firestore().collection('functionCalls').doc(documentId).update({
            'status': 'completed',
            'response.result': 'success',
            'response.data.uid': uid,
            'response.completed': admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (error) {
        await admin.firestore().collection('functionCalls').doc(documentId).update({
            'status': 'error',
            'response.errorMessage': error.message,
            'response.error': admin.firestore.FieldValue.serverTimestamp()
        });
    }
};
