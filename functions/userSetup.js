const admin = require('firebase-admin');
const { createCanvas } = require('canvas');

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

        // Generate profile photo
        const profilePhotoBuffer = await generateProfilePhoto(firstName, lastName);
        const profilePhotoPath = `users/${uid}/profilePhoto/profilePhoto.jpeg`;
        const bucket = admin.storage().bucket();
        const file = bucket.file(profilePhotoPath);

        // Upload the photo to Cloud Storage
        await file.save(profilePhotoBuffer, {
            metadata: {
                contentType: 'image/jpeg'
            }
        });

        // Update metadata for the uploaded photo
        const metadata = {
            metadata: {
                uid: uid,
                firstName: firstName,
                lastName: lastName,
                email: email,
                userType: userType,
                userStatus: userStatus
            }
        };

        await file.setMetadata(metadata);

        // Update functionCalls document status
        await admin.firestore().collection('functionCalls').doc(documentId).update({
            'status': 'completed',
            'response.result': 'success',
            'response.data.uid': uid,
            'response.completed': admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (error) {
        console.error(`Error in userSetup function: ${error.message}`);
        await admin.firestore().collection('functionCalls').doc(documentId).update({
            'status': 'error',
            'response.errorMessage': error.message,
            'response.error': admin.firestore.FieldValue.serverTimestamp()
        });
    }
};

// Helper function to generate profile photo with initials
async function generateProfilePhoto(firstName, lastName) {
    const canvas = createCanvas(200, 200);
    const context = canvas.getContext('2d');
    const initials = `${firstName[0]}${lastName[0]}`;

    // Draw background
    context.fillStyle = '#0000FF'; // Blue background
    context.fillRect(0, 0, canvas.width, canvas.height);

    // Draw initials
    context.font = 'bold 100px Arial';
    context.fillStyle = '#FFFFFF'; // White text
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(initials, canvas.width / 2, canvas.height / 2);

    // Return buffer
    return canvas.toBuffer('image/jpeg');
}