const functions = require('firebase-functions');
const admin = require('firebase-admin');

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

// General initialization and checks for all functions
async function initializeAndCheck(req, res) {
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

    if (decodedToken.uid !== uid) {
        res.status(403).send("Unauthorized: UID mismatch");
        return { proceed: false };
    }

    try {
        const user_record = await admin.auth().getUser(uid);
        const custom_claims = user_record.customClaims;
        if (!custom_claims || custom_claims.user_status !== 'active') {
            res.status(403).send({ status: "error", message: "Unauthorized: User does not have the required permissions" });
            return { proceed: false };
        }

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

        const reset_global_action_at_date = new Date(reset_global_action_at.seconds * 1000);

        if (current_time - reset_global_action_at_date > 24 * 60 * 60 * 1000) {
            total_actions_today = 0;
            await actions_ref.update({
                "general.total_actions_today": total_actions_today,
                "general.reset_global_action_at": admin.firestore.Timestamp.now()
            });
        }

        if (total_actions_today >= daily_limit) {
            res.status(429).send({ status: "error", message: "Daily action limit exceeded" });
            return { proceed: false };
        }

        total_actions_today += 1;
        await actions_ref.update({ "general.total_actions_today": total_actions_today });
        return { proceed: true, uid };
    } catch (error) {
        console.error(`Error during initialization and checks: ${error.message}`);
        res.status(500).send({ status: "error", message: error.message });
        return { proceed: false };
    }
}

module.exports.v1_delete_post = functions.https.onRequest(async (req, res) => {
    const initResult = await initializeAndCheck(req, res);
    if (!initResult.proceed) return;

    const { uid } = initResult;
    const { post_id } = req.body;

    if (!post_id) {
        res.status(400).send("Missing required parameter: post_id");
        return;
    }

    try {
        const postRef = admin.firestore().collection('posts').doc(post_id);
        const postDoc = await postRef.get();

        if (!postDoc.exists) {
            res.status(404).send({ status: "error", message: "Post not found" });
            return;
        }

        const postData = postDoc.data();
        if (postData.general?.uid !== uid) {
            res.status(403).send({ status: "error", message: "Unauthorized: UID mismatch with post owner" });
            return;
        }

        // Archive the post (set is_archived to true)
        await postRef.update({ "general.is_archived": true });

        // Update user's posts array and decrease post count
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

            const updatedPosts = userData.my_posts.posts.filter(post => post.post_id !== post_id);
            userData.my_posts.posts = updatedPosts;
            userData.my_posts.my_post_count = updatedPosts.length;

            // Decrease the post_count in the general object
            if (userData.general && typeof userData.general.post_count === 'number') {
                userData.general.post_count = Math.max(0, userData.general.post_count - 1);
            }

            transaction.set(userRef, userData, { merge: true });
        });

        res.status(200).send({ status: "success", message: "Post deleted and archived successfully" });
    } catch (error) {
        console.error(`Error in v1_delete_post function: ${error.message}`);
        res.status(500).send({ status: "error", message: error.message });
    }
});
