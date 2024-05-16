const admin = require('firebase-admin');

module.exports = async function follow(documentId, params) {
    const { following, user } = params;

    const userDocRef = admin.firestore().collection('usersRecent').doc(user.uid);
    const followedUserDocRef = admin.firestore().collection('usersRecent').doc(following.uid);
    const followingCollectionRef = admin.firestore().collection('following');

    try {
        await admin.firestore().runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userDocRef);
            const followedUserDoc = await transaction.get(followedUserDocRef);

            if (!userDoc.exists) {
                throw new Error(`User document for ${user.uid} does not exist.`);
            }

            if (!followedUserDoc.exists) {
                throw new Error(`Followed user document for ${following.uid} does not exist.`);
            }

            const userData = userDoc.data();
            const followedUserData = followedUserDoc.data();

            // Ensure following and followers arrays are initialized
            if (!userData.following) {
                userData.following = [];
            }

            if (!followedUserData.followers) {
                followedUserData.followers = [];
            }

            // Check if the following record already exists
            const existingFollowingQuery = await followingCollectionRef
                .where('user.uid', '==', user.uid)
                .where('following.uid', '==', following.uid)
                .limit(1)
                .get();

            if (!existingFollowingQuery.empty) {
                throw new Error('Following record already exists, no need to create a new one.');
            }

            // Check if the user already exists in the following array
            const userAlreadyFollowing = userData.following.some(follow => follow.uid === following.uid);

            if (userAlreadyFollowing) {
                throw new Error(`User ${user.uid} is already following ${following.uid}.`);
            }

            // Check if the user already exists in the followers array
            const followedUserAlreadyFollower = followedUserData.followers.some(follower => follower.uid === user.uid);

            if (followedUserAlreadyFollower) {
                throw new Error(`User ${following.uid} is already followed by ${user.uid}.`);
            }

            // Create new following record
            const serverTimestamp = admin.firestore.Timestamp.now();
            const followingRecord = {
                createdAt: serverTimestamp,
                user: {
                    uid: user.uid,
                    firstName: user.firstName,
                    lastName: user.lastName
                },
                following: {
                    uid: following.uid,
                    firstName: following.firstName,
                    lastName: following.lastName
                }
            };

            // Set the new following record in the following collection
            const followingDocRef = followingCollectionRef.doc();
            transaction.set(followingDocRef, followingRecord);
            const followingId = followingDocRef.id;

            // Add the new following to user's following array
            userData.following.push({
                createdAt: serverTimestamp,
                uid: following.uid,
                firstName: following.firstName,
                lastName: following.lastName,
                followingId: followingId
            });

            // Maintain at most 100 records
            if (userData.following.length > 100) {
                userData.following.sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
                userData.following.shift();
            }

            // Add the new follower to followed user's followers array
            followedUserData.followers.push({
                createdAt: serverTimestamp,
                uid: user.uid,
                firstName: user.firstName,
                lastName: user.lastName,
                followingId: followingId
            });

            // Maintain at most 100 records
            if (followedUserData.followers.length > 100) {
                followedUserData.followers.sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
                followedUserData.followers.shift();
            }

            // Update the user's and followed user's documents
            transaction.update(userDocRef, {
                following: userData.following,
                followingArrayCount: userData.following.length,
                followingTotalCount: (userData.followingTotalCount || 0) + 1
            });

            transaction.update(followedUserDocRef, {
                followers: followedUserData.followers,
                followersArrayCount: followedUserData.followers.length,
                followerTotalCount: (followedUserData.followerTotalCount || 0) + 1
            });

            // Update function call status
            await admin.firestore().collection('functionCalls').doc(documentId).update({
                'status': 'completed',
                'response.result': 'success',
                'response.data': {
                    'followingId': followingId,
                    'followingRecord': {
                        createdAt: serverTimestamp,
                        uid: following.uid,
                        firstName: following.firstName,
                        lastName: following.lastName
                    }
                },
                'response.completed': admin.firestore.FieldValue.serverTimestamp()
            });
        });

    } catch (error) {
        console.error(`Error in follow function: ${error.message}`);

        await admin.firestore().collection('functionCalls').doc(documentId).update({
            'status': 'error',
            'response.errorMessage': error.message,
            'response.error': admin.firestore.FieldValue.serverTimestamp()
        });
    }
};
