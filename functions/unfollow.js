const admin = require('firebase-admin');

module.exports = async function unfollow(documentId, params) {
    const { followingUid } = params;

    const functionCallRef = admin.firestore().collection('functionCalls').doc(documentId);

    try {
        // Step 5: Run the entire operation in a Firestore transaction
        await admin.firestore().runTransaction(async (transaction) => {
            // Step 5a: Retrieve the functionCalls document using 'documentId'
            const functionCallDoc = await transaction.get(functionCallRef);

            if (!functionCallDoc.exists) {
                throw new Error('functionCalls document does not exist.');
            }

            const functionCallData = functionCallDoc.data();

            // Step 5b: Check if the function call status is 'processing'. If so, throw an error.
            if (functionCallData.status === 'processing') {
                throw new Error('This function call is already being processed.');
            }

            // Step 5c: Retrieve the uid of the main user from the functionCalls document
            const uid = functionCallData.uid;
            if (!uid) {
                throw new Error('UID is missing in functionCalls document.');
            }

            // Log the UID before accessing the main user document
            console.log(`Attempting to retrieve main user with uid: ${uid}`);

            // Correctly reference the main user's and the following user's documents
            const mainUserRef = admin.firestore().collection('users').doc(uid);
            const followingUserRef = admin.firestore().collection('users').doc(followingUid);

            // Read all necessary documents first
            const [mainUserDoc, followingUserDoc] = await Promise.all([
                transaction.get(mainUserRef),
                transaction.get(followingUserRef)
            ]);

            if (!mainUserDoc.exists) {
                console.error(`Main user document does not exist for uid: ${uid}`);
                throw new Error('Main user does not exist.');
            }

            if (!followingUserDoc.exists) {
                throw new Error('User to unfollow does not exist.');
            }

            const mainUserData = mainUserDoc.data();
            const myFollowing = mainUserData.myFollowing || { following: [], followingCount: 0 };

            // Log the current state of the myFollowing array
            console.log(`Current myFollowing array for user ${uid}:`, myFollowing.following);

            // Step 6a: Look for the followingUid in the main user's 'myFollowing' array
            const existingFollowingIndex = myFollowing.following.findIndex(follow => follow.uid === followingUid);

            let updateMainUser = false;
            let updateFollowingUser = false;

            // Step 6b: If found and active, set 'isActive' to false and decrement 'followingCount'
            if (existingFollowingIndex !== -1) {
                if (myFollowing.following[existingFollowingIndex].isActive) {
                    myFollowing.following[existingFollowingIndex].isActive = false;
                    myFollowing.followingCount = Math.max(myFollowing.followingCount - 1, 0);  // Ensure count does not go below zero
                    updateMainUser = true;
                    console.log(`Deactivated following relationship for user ${uid} -> ${followingUid}`);
                } else {
                    console.log(`User ${uid} was not actively following user ${followingUid}, so no action is required.`);
                }
            } else {
                console.log(`User ${uid} does not have user ${followingUid} in their following list.`);
            }

            const myFollowers = followingUserDoc.data().myFollowers || { followers: [], followersCount: 0 };

            // Log the current state of the myFollowers array
            console.log(`Current myFollowers array for user ${followingUid}:`, myFollowers.followers);

            // Step 6c: Look for the main user's uid in the following user's 'myFollowers' array
            const existingFollowerIndex = myFollowers.followers.findIndex(follower => follower.uid === uid);

            // Step 6d: If found and active, set 'isActive' to false and decrement 'followersCount'
            if (existingFollowerIndex !== -1) {
                if (myFollowers.followers[existingFollowerIndex].isActive) {
                    myFollowers.followers[existingFollowerIndex].isActive = false;
                    myFollowers.followersCount = Math.max(myFollowers.followersCount - 1, 0);  // Ensure count does not go below zero
                    updateFollowingUser = true;
                    console.log(`Deactivated follower relationship for user ${followingUid} -> ${uid}`);
                } else {
                    console.log(`User ${followingUid} was not actively following user ${uid}, so no action is required.`);
                }
            } else {
                console.log(`User ${followingUid} does not have user ${uid} in their followers list.`);
            }

            // Step 7a: Update the main user's document if there were changes
            if (updateMainUser) {
                transaction.update(mainUserRef, { myFollowing });
            }

            // Step 7b: Update the following user's document if there were changes
            if (updateFollowingUser) {
                transaction.update(followingUserRef, { myFollowers });
            }

            // Step 7c: Update the functionCalls document to indicate completion
            transaction.update(functionCallRef, {
                'status': 'completed',
                'response.result': 'success',
                'response.data.followingUid': followingUid,
                'response.completed': admin.firestore.FieldValue.serverTimestamp()
            });
        });

    } catch (error) {
        console.error(`Error in unfollow function: ${error.message}`);

        let status = 'error';
        let errorMessage = error.message;

        if (error.message.includes('already being processed')) {
            status = 'concurrencyError';
            errorMessage = 'Function call hit concurrency issue';
        }

        // Step 8: Update the function call document with the appropriate error status and message
        await functionCallRef.update({
            'status': status,
            'response.errorMessage': errorMessage,
            'response.error': admin.firestore.FieldValue.serverTimestamp()
        });
    }
};
