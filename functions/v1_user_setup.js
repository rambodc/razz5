const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { createCanvas } = require('canvas');
const sharp = require('sharp');
const path = require('path');

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

module.exports.v1_user_setup = functions.https.onRequest(async (req, res) => {
    // Set CORS headers for preflight requests
    const allowed_origin = functions.config().cors.origin || '*';
    res.set('Access-Control-Allow-Origin', allowed_origin);
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
    const { uid, first_name, last_name, email, user_type, user_status, last_reset_time, daily_raz, total_reserve_raz, total_collected_raz, utc_offset, email_verified, bio, level } = req.body;

    if (!uid || !email || !user_type || !user_status || last_reset_time === undefined || daily_raz === undefined || total_reserve_raz === undefined || total_collected_raz === undefined || !bio || level === undefined) {
        return res.status(400).send("Missing required parameters");
    }

    const user_ref = admin.firestore().collection('users').doc(uid);
    const actions_ref = admin.firestore().collection('actions').doc(uid);

    try {
        // Generate a unique username based on the user's email address.
        let base_username = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 10);
        let username = base_username;

        // Check for username uniqueness before starting the transaction
        let username_taken = true;
        let count = 0;
        const users_collection = admin.firestore().collection('users');

        while (username_taken) {
            const existing_user_query = await users_collection.where('username', '==', username).get();
            if (existing_user_query.empty) {
                username_taken = false;
            } else {
                count++;
                username = `${base_username.substring(0, 10 - count.toString().length)}${count}`;
            }
        }

        // Run the entire operation in a Firestore transaction
        await admin.firestore().runTransaction(async (transaction) => {
            // Retrieve the user's document using 'uid'. If it exists, throw an error.
            const user_doc = await transaction.get(user_ref);
            if (user_doc.exists) {
                throw new Error('User already exists.');
            }

            // Create or update the user's document in the 'users' collection with provided details and generated username in a 'general' map.
            transaction.set(user_ref, {
                general: {
                    uid,
                    first_name: first_name || null,
                    last_name: last_name || null,
                    email,
                    username,  // Store the sanitized and unique username
                    user_type,
                    user_status,
                    last_reset_time,  // Add the new last_reset_time field
                    daily_raz: Number(daily_raz), // Ensure daily_raz is a number
                    created_at: admin.firestore.FieldValue.serverTimestamp(),
                    total_reserve_raz: Number(total_reserve_raz), // Add total_reserve_raz from input
                    total_collected_raz: Number(total_collected_raz), // Add total_collected_raz from input
                    utc_offset,
                    email_verified,
                    bio,
                    level // Add level to the general object
                }
            }, { merge: true });

            // Create or update the user's document in the 'actions' collection
            transaction.set(actions_ref, {
                general: {
                    uid, // Move uid into the general object
                    total_actions_today: 0,
                    reset_global_action_at: admin.firestore.FieldValue.serverTimestamp(),
                    daily_limit: 2000
                },
                functions: []
            }, { merge: true });
        });

        // Generate the profile photo with user initials and resized versions
        const profile_photo_buffer = await generate_profile_photo(first_name, last_name);
        const profile_photo_path = `users/${uid}/profile_photo/${uid}.png`;
        const bucket = admin.storage().bucket();
        const file = bucket.file(profile_photo_path);

        // Save the original and resized profile photos to Cloud Storage.
        await file.save(profile_photo_buffer, {
            metadata: {
                contentType: 'image/png'
            }
        });

        const sizes = [200, 400, 800];
        for (const size of sizes) {
            const resized_photo_path = `users/${uid}/profile_photo/${uid}_${size}x${size}.png`;
            const resized_file = bucket.file(resized_photo_path);
            const resized_buffer = await sharp(profile_photo_buffer).resize(size, size).png().toBuffer();
            await resized_file.save(resized_buffer, {
                metadata: {
                    contentType: 'image/png'
                }
            });
        }

        // Create a JSON file with user information
        const user_profile_data = {
            uid,
            first_name: first_name || null,
            last_name: last_name || null,
            email,
            username,
            user_type,
            user_status,
            bio
        };
        const user_profile_json_path = `users/${uid}/profile/${uid}_profile.json`;
        const user_profile_file = bucket.file(user_profile_json_path);
        await user_profile_file.save(JSON.stringify(user_profile_data, null, 2), {
            metadata: {
                contentType: 'application/json'
            }
        });

        // Set custom claims for the user
        await admin.auth().setCustomUserClaims(uid, {
            user_type: user_type,
            user_status: user_status
        });

        // Respond with success message
        return res.status(200).send({ status: "success", message: "User setup completed successfully", uid, username });
    } catch (error) {
        console.error(`Error in v1_user_setup function: ${error.message}`);
        return res.status(500).send({ status: "error", message: error.message });
    }
});

// Helper function to generate profile photo with initials
async function generate_profile_photo(first_name, last_name) {
    const canvas = createCanvas(200, 200);
    const context = canvas.getContext('2d');
    const initials = `${first_name ? first_name[0] : ''}${last_name ? last_name[0] : ''}`;

    context.fillStyle = '#0384fc';
    context.fillRect(0, 0, canvas.width, canvas.height);

    context.font = '100px Arial';
    context.fillStyle = '#FFFFFF';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(initials, canvas.width / 2, canvas.height / 2);

    return canvas.toBuffer('image/png');
}
