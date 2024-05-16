const admin = require('firebase-admin');

module.exports = async function unfollow(documentId, params) {
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

            // Find the following record
            const existingFollowingQuery = await followingCollectionRef
                .where('user.uid', '==', user.uid)
                .where('following.uid', '==', following.uid)
                .limit(1)
                .get();

            if (existingFollowingQuery.empty) {
                throw new Error('Following record does not exist.');
            }

            const followingDoc = existingFollowingQuery.docs[0];
            const followingId = followingDoc.id;

            // Remove the following record from the following collection
            transaction.delete(followingCollectionRef.doc(followingId));

            // Remove the following from user's following array
            userData.following = userData.following.filter(follow => follow.uid !== following.uid);

            // Maintain at most 100 records
            if (userData.following.length > 100) {
                userData.following.sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
                userData.following.shift();
            }

            // Remove the follower from followed user's followers array
            followedUserData.followers = followedUserData.followers.filter(follower => follower.uid !== user.uid);

            // Maintain at most 100 records
            if (followedUserData.followers.length > 100) {
                followedUserData.followers.sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
                followedUserData.followers.shift();
            }

            // Update the user's and followed user's documents
            transaction.update(userDocRef, {
                following: userData.following,
                followingArrayCount: userData.following.length,
                followingTotalCount: (userData.followingTotalCount || 0) - 1
            });

            transaction.update(followedUserDocRef, {
                followers: followedUserData.followers,
                followersArrayCount: followedUserData.followers.length,
                followerTotalCount: (followedUserData.followerTotalCount || 0) - 1
            });

            // Update function call status
            await admin.firestore().collection('functionCalls').doc(documentId).update({
                'status': 'completed',
                'response.result': 'success',
                'response.data': {
                    'followingId': followingId,
                    'followingRecord': {
                        uid: following.uid,
                        firstName: following.firstName,
                        lastName: following.lastName
                    }
                },
                'response.completed': admin.firestore.FieldValue.serverTimestamp()
            });
        });

    } catch (error) {
        console.error(`Error in unfollow function: ${error.message}`);

        await admin.firestore().collection('functionCalls').doc(documentId).update({
            'status': 'error',
            'response.errorMessage': error.message,
            'response.error': admin.firestore.FieldValue.serverTimestamp()
        });
    }
};
