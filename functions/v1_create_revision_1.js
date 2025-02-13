// Firebase Cloud Function: v1_create_revision_1.js
const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

// Initialize Google Cloud Storage with project ID from environment variables
const { Storage } = require('@google-cloud/storage');
const storage = new Storage({ projectId: functions.config().project_id });

const pinata_jwt = functions.config().pinata.jwt; // Access the environment variable

// General initialization and checks for all functions
async function initializeAndCheck(req, res) {
    // Set CORS headers for preflight requests
    const allowed_origin = functions.config().cors.origin || '*';
    res.set('Access-Control-Allow-Origin', allowed_origin);
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === "OPTIONS") {
        res.status(204).send('');
        return { proceed: false };
    }

    if (req.method !== "POST") {
        res.status(405).send("Method Not Allowed");
        return { proceed: false };
    }

    // Extract necessary parameters from the request body
    const { uid, post_id, revisions } = req.body;

    if (!uid || !post_id || !revisions) {
        res.status(400).send("Missing required parameters: uid, post_id, or revisions");
        return { proceed: false };
    }

    // Extract and verify Firebase Auth Token
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) {
        res.status(401).send("Unauthorized: Missing Firebase Auth Token");
        return { proceed: false };
    }

    let decodedToken;
    try {
        decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (error) {
        console.error(`Error verifying token: ${error.message}`);
        res.status(403).send("Unauthorized: Invalid Firebase Auth Token");
        return { proceed: false };
    }

    // Ensure the authenticated user's UID matches the request UID
    if (decodedToken.uid !== uid) {
        res.status(403).send("Unauthorized: UID mismatch");
        return { proceed: false };
    }

    try {
        // Verify custom claims for the user
        const user_record = await admin.auth().getUser(uid);
        const custom_claims = user_record.customClaims;
        if (!custom_claims || custom_claims.user_status !== 'active') {
            res.status(403).send({ status: "error", message: "Unauthorized: User does not have the required permissions" });
            return { proceed: false };
        }

        // General action check before proceeding
        const actions_ref = admin.firestore().collection('actions').doc(uid);
        const actions_doc = await actions_ref.get();
        if (!actions_doc.exists) {
            throw new Error('Actions document does not exist.');
        }

        const actions_data = actions_doc.data();
        const current_time = new Date();
        const reset_global_action_at = actions_data.general.reset_global_action_at;
        let total_actions_today = actions_data.general.total_actions_today;
        const daily_limit = actions_data.general.daily_limit;

        // Convert Firestore timestamp to JavaScript Date
        const reset_global_action_at_date = new Date(reset_global_action_at.seconds * 1000);

        // Check if 24 hours have passed since the last reset
        if (current_time - reset_global_action_at_date > 24 * 60 * 60 * 1000) {
            // Reset total_actions_today and update reset_global_action_at
            total_actions_today = 0;
            await actions_ref.update({
                "general.total_actions_today": total_actions_today,
                "general.reset_global_action_at": admin.firestore.Timestamp.now()
            });
        }

        // Check if the user has exceeded the daily limit
        if (total_actions_today >= daily_limit) {
            res.status(429).send({ status: "error", message: "Daily action limit exceeded" });
            return { proceed: false };
        }

        // Increment the total actions count
        total_actions_today += 1;

        // Update the actions document with the new values
        await actions_ref.update({
            "general.total_actions_today": total_actions_today
        });

        return { proceed: true, uid, post_id, revisions };
    } catch (error) {
        console.error(`Error during initialization and checks: ${error.message}`);
        res.status(500).send({ status: "error", message: error.message });
        return { proceed: false };
    }
}

module.exports.v1_create_revision_1 = functions.https.onRequest(async (req, res) => {
    // Perform general initialization and checks
    const init_result = await initializeAndCheck(req, res);
    if (!init_result.proceed) {
        return;
    }

    // Extract validated parameters
    const { uid, post_id, revisions } = init_result;

    // Reference the Firestore document for the specified post
    const postRef = admin.firestore().collection('posts').doc(post_id);
    const postDoc = await postRef.get();

    // Ensure the post exists in Firestore
    if (!postDoc.exists) {
        res.status(404).send({
            status: "error",
            message: "Post not found"
        });
        return;
    }

    // Verify ownership of the post by matching UID
    const postData = postDoc.data();
    if (postData.general?.uid !== uid) {
        res.status(403).send({
            status: "error",
            message: "Unauthorized: UID mismatch with post owner"
        });
        return;
    }

    // Initialize Cloud Storage paths for the revision file
    const bucket_name = functions.config().storage.bucket;
    const bucket = storage.bucket(bucket_name);
    const revisionPath = `posts/${post_id}/revisions/revision_1.json`;
    const tempRevisionPath = path.join(os.tmpdir(), 'revision_1.json');

    try {
        // Check if the revision file already exists in Cloud Storage
        const [exists] = await bucket.file(revisionPath).exists();
        if (exists) {
            throw new Error('Revision 1 already exists. Cannot overwrite.');
        }

        // Write the revisions object to a temporary file
        fs.writeFileSync(tempRevisionPath, JSON.stringify(revisions));

        // Upload the temporary JSON file to Cloud Storage
        await bucket.upload(tempRevisionPath, {
            destination: revisionPath,
            metadata: {
                contentType: 'application/json',
            },
        });

        // Upload the revision file to IPFS via Pinata
        console.log("Uploading revision file to IPFS via Pinata");
        const form_data = new FormData();
        form_data.append('file', fs.createReadStream(tempRevisionPath));

        const pinata_metadata = JSON.stringify({
            name: `revision_1_${post_id}`,
            keyvalues: {
                post_id: post_id,
            },
        });
        form_data.append('pinataMetadata', pinata_metadata);

        const pinata_options = JSON.stringify({
            cidVersion: 0,
        });
        form_data.append('pinataOptions', pinata_options);

        const pinataResponse = await axios.post("https://api.pinata.cloud/pinning/pinFileToIPFS", form_data, {
            maxBodyLength: "Infinity",
            headers: {
                'Content-Type': `multipart/form-data; boundary=${form_data._boundary}`,
                'Authorization': `Bearer ${pinata_jwt}`,
            },
        });

        const ipfs_hash = pinataResponse.data.IpfsHash;
        console.log("Revision file uploaded to IPFS successfully", ipfs_hash);

        // Update Firestore with the IPFS hash and revision number
        if (postData.general?.revision_number !== undefined) {
            throw new Error('Revision number already exists. Cannot create revision 1.');
        }

        // Update the general object with the new revision number, IPFS hash, and status
        await postRef.set({
            general: {
                ...postData.general,
                revision_number: 1,
                latest_revision_ipfs_hash: ipfs_hash,
                status: "monetized" // Set status to monetized
            },
        }, { merge: true });

        // Update the user's posts array to reflect the new status
        const userRef = admin.firestore().collection('users').doc(uid);
        await admin.firestore().runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) {
                throw new Error('User document does not exist.');
            }

            let userData = userDoc.data();
            if (!userData.my_posts || !userData.my_posts.posts) {
                throw new Error('User posts data does not exist.');
            }

            // Check if the post exists in the user's posts array
            const postIndex = userData.my_posts.posts.findIndex(post => post.post_id === post_id);
            if (postIndex === -1) {
                throw new Error('Post not found in user data.');
            }

            // Update only the status of the existing post
            userData.my_posts.posts[postIndex] = {
                ...userData.my_posts.posts[postIndex],
                status: "monetized" // Update status to monetized
            };

            // Update the user document with the modified posts array
            transaction.set(userRef, userData, { merge: true });
        });

        // Respond with success
        res.status(200).send({
            status: "success",
            message: "Revision 1 created successfully",
            revisionPath,
            ipfs_hash,
        });

        // Clean up the temporary file
        fs.unlinkSync(tempRevisionPath);
    } catch (error) {
        // Handle errors and update Firestore if necessary
        console.error(`Error in v1_create_revision_1 function: ${error.message}`);
        res.status(500).send({
            status: "error",
            message: error.message,
        });
    }
});
