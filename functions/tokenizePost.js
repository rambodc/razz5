const admin = require('firebase-admin');

module.exports = async function tokenizePost(documentId, params) {
    const {
        transactionObject,
        uid, // from the first level of params
        postId, // from the first level of params
        txnId, // provided txnId
        amountRaz // a number with decimal points
    } = params;

    const functionCallDocRef = admin.firestore().collection('functionCalls').doc(documentId);
    const postDocRef = admin.firestore().collection('posts').doc(postId);
    const userDocRef = admin.firestore().collection('users').doc(uid);
    const postActionsDocRef = admin.firestore().collection('postActions').doc(postId);
    const txnDocRef = admin.firestore().collection('transactions').doc(txnId); // txnId provided in params

    try {
        console.log(`Starting tokenizePost function for documentId: ${documentId}`);

        // Get the server timestamp
        const serverTimestamp = admin.firestore.Timestamp.now();

        // Run the entire operation in a Firestore transaction
        await admin.firestore().runTransaction(async (transaction) => {
            console.log(`Reading functionCalls document for documentId: ${documentId}`);

            // Step 1: Perform all reads
            const functionCallDoc = await transaction.get(functionCallDocRef);
            const userDoc = await transaction.get(userDocRef);
            const postActionsDoc = await transaction.get(postActionsDocRef);
            const postDoc = await transaction.get(postDocRef); // Retrieve the post document
            const existingTxnDoc = await transaction.get(txnDocRef); // Check if transaction already exists

            // Check if the functionCall document exists
            if (!functionCallDoc.exists) {
                throw new Error('functionCalls document does not exist.');
            }

            const functionCallData = functionCallDoc.data();

            // Check if the function is already being processed
            if (functionCallData.status === 'processing') {
                throw new Error('This function call is already being processed.');
            }

            if (!userDoc.exists) {
                throw new Error(`User document for uid ${uid} does not exist.`);
            }

            if (!postDoc.exists) {
                throw new Error(`Post document for postId ${postId} does not exist.`);
            }

            // Step 2: Check if the transaction already exists
            if (existingTxnDoc.exists) {
                console.log(`Transaction with txnId ${txnId} already exists. Skipping transaction creation.`);
                return; // If the txnId already exists, skip processing
            }

            const userData = userDoc.data();
            const { myFollowers = { followers: [] }, myFollowing = { following: [] } } = userData;

            // Filter out inactive followers and following
            const followers = myFollowers.followers
                .filter(follower => follower.isActive) // Only include active followers
                .map(follower => follower.uid);

            const following = myFollowing.following
                .filter(follow => follow.isActive) // Only include active following
                .map(follow => follow.uid);

            // Retrieve and update the totalPostRaz
            let { totalPostRaz = 0 } = postDoc.data(); // Retrieve totalPostRaz from post doc
            if (typeof totalPostRaz !== 'number') {
                throw new Error(`Post document for postId ${postId} does not have a valid totalPostRaz.`);
            }

            totalPostRaz += amountRaz; // Update totalPostRaz by adding amountRaz

            // Step 3: Perform all writes after all reads
            // Mark the function call as 'processing' within the transaction
            transaction.update(functionCallDocRef, { status: 'processing' });

            // Create a new transaction document in the 'transactions' collection
            transaction.set(txnDocRef, {
                ...transactionObject,
                txnId,
                createdAt: serverTimestamp,
                status: 'initialized'
            }, { merge: true });

            // Update the postActions document with followers, following, and status 'completed'
            transaction.set(postActionsDocRef, {
                followers: followers,
                following: following,
                status: 'completed' // Update the status to completed in postActions
            }, { merge: true });

            // Update the post document with the transaction ID, status, and updated totalPostRaz
            transaction.set(postDocRef, {
                status: 'completed',
                txnId: txnId,
                totalPostRaz: totalPostRaz // Update totalPostRaz in the post document
            }, { merge: true });

            // Update the user's totalRaz and lastPostUpdate
            let { totalRaz = 0 } = userData;
            if (typeof totalRaz !== 'number') {
                throw new Error(`User document for uid ${uid} does not have a valid totalRaz.`);
            }

            totalRaz += amountRaz;

            transaction.update(userDocRef, {
                totalRaz: totalRaz,
                lastPostUpdate: serverTimestamp
            }, { merge: true });

            // Mark the function call as "completed" to finalize the transaction
            transaction.update(functionCallDocRef, {
                status: 'completed',
                'response.result': 'success',
                'response.data.txnId': txnId,
                'response.data.postId': postId, // Include the postId in the response
                'response.completed': serverTimestamp
            }, { merge: true });
        });

        console.log(`TokenizePost function successfully completed for documentId: ${documentId}`);
    } catch (error) {
        console.error(`Error in tokenizePost function for documentId: ${documentId}: ${error.message}`);

        let status = 'error';
        let errorMessage = error.message;

        if (error.message.includes('already being processed')) {
            status = 'concurrencyError';
            errorMessage = 'Function call hit concurrency issue';
        }

        // Update function call status to error or concurrencyError
        await functionCallDocRef.update({
            status: status,
            'response.errorMessage': errorMessage,
            'response.error': admin.firestore.FieldValue.serverTimestamp()
        });
    }
};
