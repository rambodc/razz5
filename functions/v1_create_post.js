const functions = require('firebase-functions');
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

    if (req.method === "OPTIONS") {
        res.status(204).send('');
        return { proceed: false };
    }

    if (req.method !== "POST") {
        res.status(405).send("Method Not Allowed");
        return { proceed: false };
    }

    const { uid } = req.body;

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
        // Verify the user exists in the users Firestore collection
        const user_ref = admin.firestore().collection('users').doc(uid);
        const user_doc = await user_ref.get();
        if (!user_doc.exists) {
            res.status(404).send("User document does not exist in Firestore");
            return { proceed: false };
        }

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

        return { proceed: true, uid };
    } catch (error) {
        console.error(`Error during initialization and checks: ${error.message}`);
        res.status(500).send({ status: "error", message: error.message });
        return { proceed: false };
    }
}

module.exports.v1_create_post = functions.https.onRequest(async (req, res) => {
    const initResult = await initializeAndCheck(req, res);
    if (!initResult.proceed) {
        return;
    }

    const { uid } = initResult;
    const { ...post_data } = req.body;

    try {
        // Generate a new post_id automatically
        const posts_ref = admin.firestore().collection('posts');
        const new_post_ref = posts_ref.doc();
        const post_id = new_post_ref.id;

        // Create the post document with provided data and additional fields inside "general" object
        await new_post_ref.set({
            general: {
                ...post_data,
                post_id,
                created_at: admin.firestore.Timestamp.now()
            }
        }, { merge: true });

        // Start a transaction to update user data
        const user_ref = admin.firestore().collection('users').doc(uid);
        await admin.firestore().runTransaction(async (transaction) => {
            const user_doc = await transaction.get(user_ref);
            if (!user_doc.exists) {
                throw new Error('User document does not exist.');
            }

            let user_data = user_doc.data();
            if (!user_data.my_posts) {
                user_data.my_posts = { posts: [] };
            }

            // Add new post data to user's my_posts array
            user_data.my_posts.posts.unshift({
                post_id,
                ...post_data,
                created_at: admin.firestore.Timestamp.now()
            });

            // Update post count in general object
            if (!user_data.general) {
                user_data.general = { last_post_at: admin.firestore.Timestamp.now() };
            }
            user_data.general.post_count = (user_data.general.post_count || 0) + 1;
            user_data.general.last_post_at = admin.firestore.Timestamp.now();

            // Update the user document
            transaction.set(user_ref, user_data, { merge: true });
        });

        // Respond with success message
        res.status(200).send({ status: "success", message: "Post created successfully", post_id });
    } catch (error) {
        console.error(`Error in v1_create_post function: ${error.message}`);
        res.status(500).send({ status: "error", message: error.message });
    }
});
