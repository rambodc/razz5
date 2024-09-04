const admin = require('firebase-admin');

module.exports = async function follow(documentId, params) {
    const { followingUid } = params;

    const functionCallRef = admin.firestore().collection('functionCalls').doc(documentId);

    try {
        await admin.firestore().runTransaction(async (transaction) => {
            const functionCallDoc = await transaction.get(functionCallRef);

            if (!functionCallDoc.exists) {
                throw new Error('functionCalls document does not exist.');
            }

            const functionCallData = functionCallDoc.data();

            if (functionCallData.status === 'processing') {
                throw new Error('This function call is already being processed.');
            }

            // Retrieve the uid of the main user from the functionCalls document
            const uid = functionCallData.uid;
            if (!uid) {
                throw new Error('UID is missing in functionCalls document.');
            }

            // Check if the user is trying to follow themselves
            if (uid === followingUid) {
                throw new Error('A user cannot follow themselves.');
            }

            // Log the UID before accessing the main user document
            console.log(`Attempting to retrieve main user with uid: ${uid}`);

            // Correctly reference the main user's document using the retrieved uid
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
                throw new Error('User to follow does not exist.');
            }

            const mainUserData = mainUserDoc.data();
            const myFollowing = mainUserData.myFollowing || { following: [], followingCount: 0 };

            // Log the current state of the myFollowing array
            console.log(`Current myFollowing array for user ${uid}:`, myFollowing.following);

            if (myFollowing.followingCount >= 100) {
                throw new Error('User has reached the maximum number of followings.');
            }

            // Check if the main user is already following the followingUid
            const existingFollowingIndex = myFollowing.following.findIndex(follow => follow.uid === followingUid);

            // Variables to track changes for the following relationship
            let updateMainUser = false;
            let updateFollowingUser = false;

            if (existingFollowingIndex !== -1) {
                // User already exists in the following list
                if (myFollowing.following[existingFollowingIndex].isActive) {
                    // Correctly identify this as already active and do not attempt to follow again
                    console.error(`User ${uid} is already actively following user ${followingUid}`);
                    throw new Error('User is already actively following this user.');
                } else {
                    // Reactivate the following relationship
                    myFollowing.following[existingFollowingIndex].isActive = true;
                    myFollowing.followingCount++;  // Increment following count
                    updateMainUser = true;
                    console.log(`Reactivated following relationship for user ${uid} -> ${followingUid}`);
                }
            } else {
                const { firstName, lastName, profilePhoto200Url, username: followingUsername } = followingUserDoc.data();

                // Add new following object with isActive set to true and totalRaz set to 0
                myFollowing.following.push({
                    uid: followingUid,
                    firstName,
                    lastName,
                    profilePhoto200Url,
                    username: followingUsername,
                    isActive: true,
                    totalRaz: 0
                });
                myFollowing.followingCount++;
                updateMainUser = true;
                console.log(`Added following relationship for user ${uid} -> ${followingUid}`);
            }

            const myFollowers = followingUserDoc.data().myFollowers || { followers: [], followersCount: 0 };

            // Check if the main user is already a follower of the followingUid
            const existingFollowerIndex = myFollowers.followers.findIndex(follower => follower.uid === uid);

            if (existingFollowerIndex !== -1) {
                // Main user already exists in the followers list
                if (myFollowers.followers[existingFollowerIndex].isActive) {
                    // This error is unnecessary for followers; it should not stop the follow operation
                    console.log(`User ${uid} is already a follower of ${followingUid} but will not cause an error.`);
                } else {
                    // Reactivate the follower relationship
                    myFollowers.followers[existingFollowerIndex].isActive = true;
                    myFollowers.followersCount++;  // Increment followers count
                    updateFollowingUser = true;
                    console.log(`Reactivated follower relationship for user ${followingUid} -> ${uid}`);
                }
            } else {
                const { firstName: mainFirstName, lastName: mainLastName, profilePhoto200Url: mainProfilePhoto200Url, username: mainUsername } = mainUserData;

                // Add new follower object with isActive set to true and totalRaz set to 0
                myFollowers.followers.push({
                    uid: uid,
                    firstName: mainFirstName,
                    lastName: mainLastName,
                    profilePhoto200Url: mainProfilePhoto200Url,
                    username: mainUsername,
                    isActive: true,
                    totalRaz: 0
                });
                myFollowers.followersCount++;
                updateFollowingUser = true;
                console.log(`Added follower relationship for user ${followingUid} -> ${uid}`);
            }

            // Perform writes after all reads
            if (updateMainUser) {
                transaction.update(mainUserRef, { myFollowing });
            }

            if (updateFollowingUser) {
                transaction.update(followingUserRef, { myFollowers });
            }

            transaction.update(functionCallRef, {
                'status': 'completed',
                'response.result': 'success',
                'response.data.followingUid': followingUid,
                'response.completed': admin.firestore.FieldValue.serverTimestamp()
            });
        });

    } catch (error) {
        console.error(`Error in follow function: ${error.message}`);

        let status = 'error';
        let errorMessage = error.message;

        if (error.message.includes('already being processed')) {
            status = 'concurrencyError';
            errorMessage = 'Function call hit concurrency issue';
        }

        await functionCallRef.update({
            'status': status,
            'response.errorMessage': errorMessage,
            'response.error': admin.firestore.FieldValue.serverTimestamp()
        });
    }
};
