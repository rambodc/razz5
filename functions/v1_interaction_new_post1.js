const functions = require('firebase-functions');
const admin = require('firebase-admin');

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

// Function to perform initial checks and validations
async function initializeAndCheck(req, res) {
    // Set CORS headers for cross-origin requests
    const allowed_origin = functions.config().cors.origin || '*';
    res.set('Access-Control-Allow-Origin', allowed_origin);
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle preflight requests
    if (req.method === "OPTIONS") {
        res.status(204).send('');
        return { proceed: false };
    }

    // Only allow POST requests
    if (req.method !== "POST") {
        res.status(405).send("Method Not Allowed");
        return { proceed: false };
    }

    // Validate required UID parameter in the request body
    const { uid } = req.body;
    if (!uid) {
        res.status(400).send("Missing required parameter: uid");
        return { proceed: false };
    }

    // Extract and verify the Firebase Auth token
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) {
        res.status(401).send("Unauthorized: Missing Firebase Auth Token");
        return { proceed: false };
    }

    let decodedToken;
    try {
        decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (error) {
        res.status(403).send("Unauthorized: Invalid Firebase Auth Token");
        return { proceed: false };
    }

    // Ensure the authenticated user's UID matches the provided UID
    if (decodedToken.uid !== uid) {
        res.status(403).send("Unauthorized: UID mismatch");
        return { proceed: false };
    }

    try {
        // Verify that the user exists in the Firestore database
        const user_ref = admin.firestore().collection('users').doc(uid);
        const user_doc = await user_ref.get();
        if (!user_doc.exists) {
            res.status(404).send("User document does not exist in Firestore");
            return { proceed: false };
        }

        // Check and update action limits for the user
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

        // Reset daily action count if more than 24 hours have passed since the last reset
        const reset_global_action_at_date = new Date(reset_global_action_at.seconds * 1000);
        if (current_time - reset_global_action_at_date > 24 * 60 * 60 * 1000) {
            total_actions_today = 0;
            await actions_ref.update({
                "general.total_actions_today": total_actions_today,
                "general.reset_global_action_at": admin.firestore.Timestamp.now()
            });
        }

        // Enforce the daily action limit
        if (total_actions_today >= daily_limit) {
            res.status(429).send({ status: "error", message: "Daily action limit exceeded" });
            return { proceed: false };
        }

        // Increment the action count for today
        total_actions_today += 1;
        await actions_ref.update({
            "general.total_actions_today": total_actions_today
        });

        return { proceed: true, uid };
    } catch (error) {
        res.status(500).send({ status: "error", message: error.message });
        return { proceed: false };
    }
}

module.exports.v1_interaction_new_post1 = functions.https.onRequest(async (req, res) => {
    // Perform initial checks and validations
    const initResult = await initializeAndCheck(req, res);
    if (!initResult.proceed) {
        return;
    }

    const { uid } = initResult;
    const { general, newpost1 } = req.body;

    try {
        // Check if the interaction already exists in the interactions collection
        const interactionRef = admin.firestore().collection('interactions').doc(general.interaction_id);
        const interactionDoc = await interactionRef.get();
        if (interactionDoc.exists) {
            res.status(400).send({ status: "error", message: "Interaction already exists." });
            return;
        }

        // Extract the first element of the newpost1 array
        const postValueData = newpost1[0];
        const postRef = admin.firestore().collection('posts').doc(postValueData.post_id);
        const postDoc = await postRef.get();

        if (!postDoc.exists) {
            res.status(404).send({ status: "error", message: "Post does not exist." });
            return;
        }

        const postGeneral = postDoc.data().general;

        // Check post status and archive state
        if (postGeneral.status !== 'monetized') {
            res.status(403).send({ status: "error", message: "Post is not monetized." });
            return;
        }

        if (postGeneral.is_archived) {
            res.status(403).send({ status: "error", message: "Post is archived." });
            return;
        }

        const totalPostRaz = postGeneral.total_post_raz || 0;

        // Run a Firestore transaction to ensure data consistency
        await admin.firestore().runTransaction(async (transaction) => {
            // Add the interaction document to Firestore
            transaction.set(interactionRef, { general: { ...general, created_at: admin.firestore.Timestamp.now() }, newpost1 });

            // Update the total_post_raz value in the post document
            transaction.update(postRef, {
                "general.total_post_raz": totalPostRaz + postValueData.amount
            });

            // Update the user's my_posts array in their document
            const userRef = admin.firestore().collection('users').doc(uid);
            const userDoc = await userRef.get();

            if (userDoc.exists) {
                const userData = userDoc.data();

                if (userData.my_posts && Array.isArray(userData.my_posts.posts)) {
                    const updatedPosts = userData.my_posts.posts.map(post => {
                        if (post.post_id === postValueData.post_id) {
                            // Update the total_post_raz for the matching post
                            return { ...post, total_post_raz: totalPostRaz + postValueData.amount };
                        }
                        return post;
                    });

                    // Commit the updated posts array back to Firestore
                    transaction.update(userRef, {
                        "my_posts.posts": updatedPosts
                    });
                }
            }
        });

        res.status(200).send({ status: "success", message: "Interaction recorded successfully." });
    } catch (error) {
        res.status(500).send({ status: "error", message: error.message });
    }
});
