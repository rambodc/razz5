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
    const { uid, file_path, post_id } = req.body;

    if (!uid || !file_path || !post_id) {
        res.status(400).send("Missing required parameters: uid, file_path, or post_id");
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

    const user_ref = admin.firestore().collection('users').doc(uid);
    const actions_ref = admin.firestore().collection('actions').doc(uid);

    try {
        // Verify custom claims for the user
        const user_record = await admin.auth().getUser(uid);
        const custom_claims = user_record.customClaims;
        if (!custom_claims || (custom_claims.user_type !== 'user' && custom_claims.user_type !== 'admin') || custom_claims.user_status !== 'active') {
            res.status(403).send({ status: "error", message: "Unauthorized: User does not have the required permissions" });
            return { proceed: false };
        }

        // General action check before proceeding
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

        return { proceed: true, uid, file_path, post_id };
    } catch (error) {
        console.error(`Error during initialization and checks: ${error.message}`);
        res.status(500).send({ status: "error", message: error.message });
        return { proceed: false };
    }
}

module.exports.v1_pinata_upload = functions.https.onRequest(async (req, res) => {
    const initResult = await initializeAndCheck(req, res);
    if (!initResult.proceed) {
        return;
    }

    const { uid, file_path, post_id } = initResult;

    try {
        // Post-specific check for ownership
        const postRef = admin.firestore().collection('posts').doc(post_id);
        const postDoc = await postRef.get();

        if (!postDoc.exists) {
            res.status(404).send({
                status: "error",
                message: "Post not found"
            });
            return;
        }

        const postData = postDoc.data();
        if (postData.general?.uid !== uid) {
            res.status(403).send({
                status: "error",
                message: "Unauthorized: UID mismatch with post owner"
            });
            return;
        }

        console.log("Downloading file from Cloud Storage");
        const bucket_name = functions.config().storage.bucket;
        const bucket = storage.bucket(bucket_name);
        const file = bucket.file(file_path);
        const temp_file_path = path.join(os.tmpdir(), path.basename(file_path));

        await file.download({ destination: temp_file_path });

        console.log("Uploading file to IPFS via Pinata");
        const form_data = new FormData();
        form_data.append('file', fs.createReadStream(temp_file_path));

        const pinata_metadata = JSON.stringify({
            name: path.basename(file_path),
            keyvalues: {
                post_id: post_id
            }
        });
        form_data.append('pinataMetadata', pinata_metadata);

        const pinata_options = JSON.stringify({
            cidVersion: 0
        });
        form_data.append('pinataOptions', pinata_options);

        const response = await axios.post("https://api.pinata.cloud/pinning/pinFileToIPFS", form_data, {
            maxBodyLength: "Infinity",
            headers: {
                'Content-Type': `multipart/form-data; boundary=${form_data._boundary}`,
                'Authorization': `Bearer ${pinata_jwt}`
            }
        });

        const ipfs_hash = response.data.IpfsHash;
        const gateway_url = `https://gateway.pinata.cloud/ipfs/${ipfs_hash}`;

        console.log("File uploaded to IPFS successfully");

        // Update the Firestore document with the IPFS hash
        await postRef.update({
            "general.content_ipfs_hash": ipfs_hash
        });

        // Respond with success message
        return res.status(200).send({
            status: "success",
            message: "File uploaded to IPFS successfully",
            hash: ipfs_hash,
            url: gateway_url
        });
    } catch (error) {
        console.error(`Error in v1_pinata_upload function: ${error.message}`);
        return res.status(500).send({ status: "error", message: error.message });
    }
});
