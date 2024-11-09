// Firebase Cloud Function: v1UserSetup.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { createCanvas } = require('canvas');
const sharp = require('sharp');
const path = require('path');

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

module.exports.v1UserSetup = functions.https.onRequest(async (req, res) => {
    // Set CORS headers for preflight requests
    const allowedOrigin = functions.config().cors.origin || '*';
    res.set('Access-Control-Allow-Origin', allowedOrigin);
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === "OPTIONS") {
        // Handle preflight request
        res.status(204).send('');
        return;
    }

    if (req.method !== "POST") {
        return res.status(405).send("Method Not Allowed");
    }

    // Extract necessary parameters from the request body
    const { uid, firstName, lastName, email, userType, userStatus, emailVerified, utcOffset, lastResetTime, dailyRaz, totalRaz } = req.body;

    if (!uid || !email || !userType || !userStatus || emailVerified === undefined || !utcOffset || lastResetTime === undefined || dailyRaz === undefined || totalRaz === undefined) {
        return res.status(400).send("Missing required parameters");
    }

    const userRef = admin.firestore().collection('users').doc(uid);

    try {
        // Generate a unique username based on the user's email address.
        let baseUsername = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 10);
        let username = baseUsername;

        // Check for username uniqueness before starting the transaction
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

        // Run the entire operation in a Firestore transaction
        await admin.firestore().runTransaction(async (transaction) => {
            // Retrieve the user's document using 'uid'. If it exists, throw an error.
            const userDoc = await transaction.get(userRef);
            if (userDoc.exists) {
                throw new Error('User already exists.');
            }

            // Create or update the user's document in the 'users' collection with provided details and generated username in a 'general' map.
            transaction.set(userRef, {
                general: {
                    uid,
                    firstName: firstName || null,
                    lastName: lastName || null,
                    email,
                    username,  // Store the sanitized and unique username
                    userType,
                    userStatus,
                    emailVerified,
                    utcOffset,
                    lastResetTime,  // Add the new lastResetTime field
                    dailyRaz: Number(dailyRaz), // Ensure dailyRaz is a number
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    key: "string",
                    totalRaz: Number(totalRaz) // Add totalRaz from input
                }
            }, { merge: true });
        });

        // Generate the profile photo with user initials and resized versions
        const profilePhotoBuffer = await generateProfilePhoto(firstName, lastName);
        const profilePhotoPath = `users/${uid}/profilePhoto/${uid}.png`;
        const bucket = admin.storage().bucket();
        const file = bucket.file(profilePhotoPath);

        // Save the original and resized profile photos to Cloud Storage.
        await file.save(profilePhotoBuffer, {
            metadata: {
                contentType: 'image/png'
            }
        });

        const sizes = [200, 400, 800];
        for (const size of sizes) {
            const resizedPhotoPath = `users/${uid}/profilePhoto/${uid}_${size}x${size}.png`;
            const resizedFile = bucket.file(resizedPhotoPath);
            const resizedBuffer = await sharp(profilePhotoBuffer).resize(size, size).png().toBuffer();
            await resizedFile.save(resizedBuffer, {
                metadata: {
                    contentType: 'image/png'
                }
            });
        }

        // Create a JSON file with user information
        const userProfileData = {
            uid,
            firstName: firstName || null,
            lastName: lastName || null,
            email,
            username,
            userType,
            userStatus,
            emailVerified
        };
        const userProfileJsonPath = `users/${uid}/profile/${uid}_profile.json`;
        const userProfileFile = bucket.file(userProfileJsonPath);
        await userProfileFile.save(JSON.stringify(userProfileData, null, 2), {
            metadata: {
                contentType: 'application/json'
            }
        });

        // Set custom claims for the user
        await admin.auth().setCustomUserClaims(uid, {
            userType: userType,
            userStatus: userStatus
        });

        // Respond with success message
        return res.status(200).send({ status: "success", message: "User setup completed successfully", uid, username });
    } catch (error) {
        console.error(`Error in v1UserSetup function: ${error.message}`);
        return res.status(500).send({ status: "error", message: error.message });
    }
});

// Helper function to generate profile photo with initials
async function generateProfilePhoto(firstName, lastName) {
    const canvas = createCanvas(200, 200);
    const context = canvas.getContext('2d');
    const initials = `${firstName ? firstName[0] : ''}${lastName ? lastName[0] : ''}`;

    context.fillStyle = '#0384fc';
    context.fillRect(0, 0, canvas.width, canvas.height);

    context.font = '100px Arial';
    context.fillStyle = '#FFFFFF';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(initials, canvas.width / 2, canvas.height / 2);

    return canvas.toBuffer('image/png');
}
