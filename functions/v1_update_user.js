const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

// General initialization and checks for all functions
async function initializeAndCheck(req, res) {
    // Set CORS headers for preflight requests
    const allowed_origin = functions.config().cors.origin || '*';
    res.set('Access-Control-Allow-Origin', allowed_origin);
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle preflight requests
    if (req.method === "OPTIONS") {
        res.status(204).send('');
        return { proceed: false };
    }

    // Ensure the request method is POST
    if (req.method !== "POST") {
        res.status(405).send("Method Not Allowed");
        return { proceed: false };
    }

    // Extract UID from request body
    const { uid } = req.body;

    // Ensure UID is present
    if (!uid) {
        res.status(400).send("Missing required parameter: uid");
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
        // Verify the token with Firebase Admin SDK
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
        // Retrieve user record and verify custom claims
        const user_record = await admin.auth().getUser(uid);
        const custom_claims = user_record.customClaims;
        if (!custom_claims || custom_claims.user_status !== 'active') {
            res.status(403).send({ status: "error", message: "Unauthorized: User does not have the required permissions" });
            return { proceed: false };
        }

        // Check actions document for user limits
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

        return { proceed: true, uid };
    } catch (error) {
        console.error(`Error during initialization and checks: ${error.message}`);
        res.status(500).send({ status: "error", message: error.message });
        return { proceed: false };
    }
}

module.exports.v1_update_user = functions.https.onRequest(async (req, res) => {
    const initResult = await initializeAndCheck(req, res);
    if (!initResult.proceed) {
        return;
    }

    const { uid } = initResult;
    const { update_json, object_name, ...update_data } = req.body;

    // Validate required parameters
    if (!object_name) {
        res.status(400).send("Missing required parameter: object_name");
        return;
    }

    try {
        // Reference to Firestore user document
        const userRef = admin.firestore().collection('users').doc(uid);
        const userDoc = await userRef.get();

        // Check if user document exists
        if (!userDoc.exists) {
            res.status(404).send({
                status: "error",
                message: "User not found"
            });
            return;
        }

        // Update the specified object in Firestore
        await userRef.set({
            [object_name]: {
                ...userDoc.data()[object_name],
                ...update_data
            }
        }, { merge: true });

        if (update_json) {
            // Update the JSON profile in Cloud Storage
            const bucket = admin.storage().bucket();
            const userProfilePath = `users/${uid}/profile/${uid}_profile.json`;
            const userProfileFile = bucket.file(userProfilePath);

            let existingProfile = {};
            try {
                // Check if JSON file exists and read it
                const [fileExists] = await userProfileFile.exists();
                if (fileExists) {
                    const [fileContent] = await userProfileFile.download();
                    existingProfile = JSON.parse(fileContent.toString());
                }
            } catch (error) {
                console.error(`Error reading existing profile JSON: ${error.message}`);
            }

            // Merge updates into the existing JSON profile
            const updatedProfile = {
                ...existingProfile,
                ...update_data
            };

            // Save updated JSON back to Cloud Storage
            await userProfileFile.save(JSON.stringify(updatedProfile, null, 2), {
                metadata: {
                    contentType: 'application/json'
                }
            });
        }

        res.status(200).send({ status: "success", message: "User updated successfully" });
    } catch (error) {
        console.error(`Error in v1_update_user function: ${error.message}`);
        res.status(500).send({ status: "error", message: error.message });
    }
});
