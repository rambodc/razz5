const admin = require('firebase-admin');
const { createCanvas } = require('canvas');
const sharp = require('sharp');
const path = require('path');

module.exports = async function userSetup(documentId, params) {
    const { uid, firstName, lastName, email, userType, userStatus, emailVerified, utcOffset } = params;

    const functionCallRef = admin.firestore().collection('functionCalls').doc(documentId);
    const userRef = admin.firestore().collection('users').doc(uid);
    const conversationRef = admin.firestore().collection('conversation').doc(uid);
    const chatsRef = conversationRef.collection('chats').doc();

    try {
        await admin.firestore().runTransaction(async (transaction) => {
            const functionCallDoc = await transaction.get(functionCallRef);

            if (!functionCallDoc.exists) {
                throw new Error('functionCalls document does not exist.');
            }

            const functionCallData = functionCallDoc.data();

            if (functionCallData.status === 'processing') {
                throw new Error('This function call is already being processed.');
            }

            const userDoc = await transaction.get(userRef);
            if (userDoc.exists) {
                throw new Error('User already exists.');
            }

            // Create initial username from email
            let baseUsername = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
            let username = baseUsername;

            // Check for username uniqueness
            let usernameTaken = true;
            let count = 0;
            const usersCollection = admin.firestore().collection('users');

            while (usernameTaken) {
                const existingUserQuery = await usersCollection.where('username', '==', username).get();
                if (existingUserQuery.empty) {
                    usernameTaken = false;
                } else {
                    count++;
                    username = `${baseUsername}${count}`;
                }
            }

            transaction.update(functionCallRef, {
                'status': 'processing'
            });

            transaction.set(userRef, {
                uid,
                firstName,
                lastName,
                email,
                username,  // Store the sanitized and unique username
                userType,
                userStatus,
                emailVerified: emailVerified === 'true',
                utcOffset
            }, { merge: true });

            transaction.set(conversationRef, {}, { merge: true });
            transaction.set(chatsRef, {}, { merge: true });

            transaction.update(functionCallRef, {
                'status': 'completed',
                'response.result': 'success',
                'response.data.uid': uid,
                'response.data.username': username, // Include the username in the response
                'response.completed': admin.firestore.FieldValue.serverTimestamp()
            });
        });

        // Generate profile photo and resized photos
        const profilePhotoBuffer = await generateProfilePhoto(firstName, lastName);
        const profilePhotoPath = `users/${uid}/profilePhoto/${uid}.png`;
        const bucket = admin.storage().bucket();
        const file = bucket.file(profilePhotoPath);

        await file.save(profilePhotoBuffer, {
            metadata: {
                contentType: 'image/png'
            }
        });

        const sizes = [200, 400, 800];
        const resizedPaths = {};
        for (const size of sizes) {
            const resizedPhotoPath = `users/${uid}/profilePhoto/${uid}_${size}x${size}.png`;
            const resizedFile = bucket.file(resizedPhotoPath);
            const resizedBuffer = await sharp(profilePhotoBuffer).resize(size, size).png().toBuffer();
            await resizedFile.save(resizedBuffer, {
                metadata: {
                    contentType: 'image/png'
                }
            });
            resizedPaths[size] = resizedPhotoPath;
        }

        // Get URLs for the images
        const getDownloadUrl = async (filePath) => {
            const file = bucket.file(filePath);
            const [metadata] = await file.getMetadata();
            let token = metadata.metadata ? metadata.metadata.firebaseStorageDownloadTokens : null;

            if (!token) {
                const config = {
                    action: 'read',
                    expires: '03-01-2500'
                };
                const [url] = await file.getSignedUrl(config);
                token = url.split('token=')[1];
            }

            return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(filePath)}?alt=media&token=${token}`;
        };

        const profilePhotoOriginalUrl = await getDownloadUrl(profilePhotoPath);
        const profilePhoto200Url = await getDownloadUrl(resizedPaths[200]);
        const profilePhoto400Url = await getDownloadUrl(resizedPaths[400]);
        const profilePhoto800Url = await getDownloadUrl(resizedPaths[800]);

        // Update user document with photo URLs
        await userRef.update({
            profilePhotoOriginalUrl,
            profilePhoto200Url,
            profilePhoto400Url,
            profilePhoto800Url
        });

    } catch (error) {
        console.error(`Error in userSetup function: ${error.message}`);

        let status = 'error';
        let errorMessage = error.message;

        if (error.message.includes('already being processed')) {
            status = 'concurrencyError';
            errorMessage = 'Function call hit concurrency issue';
        }

        await admin.firestore().collection('functionCalls').doc(documentId).update({
            'status': status,
            'response.errorMessage': errorMessage,
            'response.error': admin.firestore.FieldValue.serverTimestamp()
        });
    }
};

// Helper function to generate profile photo with initials
async function generateProfilePhoto(firstName, lastName) {
    const canvas = createCanvas(200, 200);
    const context = canvas.getContext('2d');
    const initials = `${firstName[0]}${lastName[0]}`;

    context.fillStyle = '#0384fc';
    context.fillRect(0, 0, canvas.width, canvas.height);

    context.font = '100px Arial';
    context.fillStyle = '#FFFFFF';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(initials, canvas.width / 2, canvas.height / 2);

    return canvas.toBuffer('image/png');
}
