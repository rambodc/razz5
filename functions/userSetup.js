/*
Steps of the function:

1. Import required modules: 'firebase-admin', 'canvas', and 'sharp'.
2. Export an asynchronous function 'userSetup' with parameters: documentId and params.
3. Extract parameters from the 'params' object: uid, firstName, lastName, email, userType, userStatus, emailVerified, and utcOffset.
4. Define Firestore references for 'functionCalls', 'users', 'usersPublic', 'conversation', and 'chats' collections.
5. Run the entire operation in a Firestore transaction:
    a. Retrieve the functionCalls document using 'documentId'.
    b. Check if the function call status is 'processing'. If so, throw an error.
    c. Retrieve the user's document using 'uid'. If it exists, throw an error.
    d. Generate a unique username based on the user's email address.
    e. Mark the function call as processing.
    f. Create or update the user's document in the 'users' collection with provided details and generated username.
    g. Create empty documents for 'conversation' and 'chats' subcollection for the user.
    h. Update the functionCalls document with the completion status and response data.
6. Generate the profile photo with user initials and resized versions:
    a. Create a base profile photo with initials using the canvas.
    b. Save the original and resized profile photos to Cloud Storage.
    c. Generate download URLs for all saved images.
7. Update the 'users' document with photo URLs.
8. Create a document in the 'usersPublic' collection with the same uid:
    a. Store firstName, lastName, and profile photo URLs.
9. Catch and handle any errors:
    a. Log the error message.
    b. Update the functionCalls document with the appropriate error status and message.
*/

const admin = require('firebase-admin');
const { createCanvas } = require('canvas');
const sharp = require('sharp');
const path = require('path');

module.exports = async function userSetup(documentId, params) {
    const { uid, firstName, lastName, email, userType, userStatus, emailVerified, utcOffset } = params;

    const functionCallRef = admin.firestore().collection('functionCalls').doc(documentId);
    const userRef = admin.firestore().collection('users').doc(uid);
    const usersPublicRef = admin.firestore().collection('usersPublic').doc(uid);
    const conversationRef = admin.firestore().collection('conversation').doc(uid);
    const chatsRef = conversationRef.collection('chats').doc();

    try {
        // 5. Run the entire operation in a Firestore transaction
        await admin.firestore().runTransaction(async (transaction) => {
            // 5a. Retrieve the functionCalls document using 'documentId'
            const functionCallDoc = await transaction.get(functionCallRef);

            // 5b. Check if the function call status is 'processing'. If so, throw an error.
            if (!functionCallDoc.exists) {
                throw new Error('functionCalls document does not exist.');
            }

            const functionCallData = functionCallDoc.data();

            if (functionCallData.status === 'processing') {
                throw new Error('This function call is already being processed.');
            }

            // 5c. Retrieve the user's document using 'uid'. If it exists, throw an error.
            const userDoc = await transaction.get(userRef);
            if (userDoc.exists) {
                throw new Error('User already exists.');
            }

            // 5d. Generate a unique username based on the user's email address.
            let baseUsername = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 10);
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
                    username = `${baseUsername.substring(0, 10 - count.toString().length)}${count}`;
                }
            }

            // 5e. Mark the function call as processing.
            transaction.update(functionCallRef, {
                'status': 'processing'
            });

            // 5f. Create or update the user's document in the 'users' collection with provided details and generated username.
            transaction.set(userRef, {
                uid,
                firstName,
                lastName,
                email,
                username,  // Store the sanitized and unique username
                userType,
                userStatus,
                emailVerified: emailVerified === 'true',
                utcOffset,
                createdAt: admin.firestore.FieldValue.serverTimestamp() // Add the createdAt field
            }, { merge: true });

            // 5g. Create empty documents for 'conversation' and 'chats' subcollection for the user.
            transaction.set(conversationRef, {}, { merge: true });
            transaction.set(chatsRef, {}, { merge: true });

            // 5h. Update the functionCalls document with the completion status and response data.
            transaction.update(functionCallRef, {
                'status': 'completed',
                'response.result': 'success',
                'response.data.uid': uid,
                'response.data.username': username, // Include the username in the response
                'response.completed': admin.firestore.FieldValue.serverTimestamp()
            });
        });

        // 6. Generate the profile photo with user initials and resized versions
        // 6a. Create a base profile photo with initials using the canvas.
        const profilePhotoBuffer = await generateProfilePhoto(firstName, lastName);
        const profilePhotoPath = `users/${uid}/profilePhoto/${uid}.png`;
        const bucket = admin.storage().bucket();
        const file = bucket.file(profilePhotoPath);

        // 6b. Save the original and resized profile photos to Cloud Storage.
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

        // 6c. Generate download URLs for all saved images.
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

        // 7. Update the 'users' document with photo URLs.
        await userRef.update({
            profilePhotoOriginalUrl,
            profilePhoto200Url,
            profilePhoto400Url,
            profilePhoto800Url
        });

        // 8. Create a document in the 'usersPublic' collection with the same uid
        // 8a. Store firstName, lastName, and profile photo URLs.
        await usersPublicRef.set({
            uid,
            firstName,
            lastName,
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

        // 9. Catch and handle any errors
        // 9a. Log the error message.
        // 9b. Update the functionCalls document with the appropriate error status and message.
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
