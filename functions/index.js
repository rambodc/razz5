const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

const vertexProject = functions.config().vertex.project;
const vertexLocation = functions.config().vertex.location;
const bucketName = functions.config().bucket.name;



exports.runAI4 = require('./runAI4').runAI4;
exports.runAI3 = require('./runAI3').runAI3;
exports.extAddUidPost = require('./extAddUidPost').extAddUidPost;
exports.extAddUidUser = require('./extAddUidUser').extAddUidUser;

exports.v1_user_setup = require('./v1_user_setup').v1_user_setup;

exports.v1_last_reset_time = require('./v1_last_reset_time').v1_last_reset_time;

exports.v1_post_og_page = require('./v1_post_og_page').v1_post_og_page;

exports.v1_update_email = require('./v1_update_email').v1_update_email;

exports.v1_update_utc_offset = require('./v1_update_utc_offset').v1_update_utc_offset;

exports.v1_update_email_verified = require('./v1_update_email_verified').v1_update_email_verified;

exports.v1_create_new_chat = require('./v1_create_new_chat').v1_create_new_chat;

exports.v1_update_chat = require('./v1_update_chat').v1_update_chat;

exports.v1_pinata_upload = require('./v1_pinata_upload').v1_pinata_upload;

exports.v1_create_post = require('./v1_create_post').v1_create_post;

exports.v1_resize_file = require('./v1_resize_file').v1_resize_file;




// Central functionHandler
exports.functionHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        const functionName = data.functionName;
        const parameters = data.parameters;
        const documentId = context.params.documentId;
        const userStatus = data.userStatus;

        try {
            // Check if userStatus is "active"
            if (userStatus !== "active") {
                throw new Error(`User status is ${userStatus}. Only active users can trigger functions.`);
            }

            const func = require(`./${functionName}`);

            if (func && typeof func === 'function') {
                await func(documentId, parameters, bucketName, vertexProject, vertexLocation);
            } else {
                throw new Error(`The function ${functionName} is not available or is not a valid function.`);
            }
        } catch (error) {
            console.error(`Error executing ${functionName}: ${error}`);

            let status = 'error';
            let errorMessage = error.message;

            if (error.message.includes('already being processed')) {
                status = 'concurrencyError';
                errorMessage = 'Function call hit concurrency issue';
            }

            await admin.firestore().collection('functionCalls').doc(documentId).update({
                'status': status,
                'response.errorMessage': errorMessage,
                'response.error': admin.firestore.FieldValue.serverTimestamp()
            });
        }
    });

// Individual function handlers (unchanged)
exports.inviteRequestHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        if (data.functionName === 'inviteRequest') {
            const inviteRequest = require('./inviteRequest');
            await inviteRequest(context.params.documentId, data.parameters, bucketName, vertexProject, vertexLocation);
        }
    });



exports.userSetupHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        if (data.functionName === 'userSetup') {
            const userSetup = require('./userSetup');
            await userSetup(context.params.documentId, data.parameters, bucketName, vertexProject, vertexLocation);
        }
    });

exports.runAIHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        if (data.functionName === 'runAI') {
            const runAI = require('./runAI');
            await runAI(context.params.documentId, data.parameters, bucketName, vertexProject, vertexLocation);
        }
    });

exports.createPostHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        if (data.functionName === 'createPost') {
            const createPost = require('./createPost');
            await createPost(context.params.documentId, data.parameters);
        }
    });

exports.updateEmailHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        if (data.functionName === 'updateEmail') {
            const updateEmail = require('./updateEmail');
            await updateEmail(context.params.documentId, data.parameters);
        }
    });

exports.updateUtcOffsetHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        if (data.functionName === 'updateUtcOffset') {
            const updateUtcOffset = require('./updateUtcOffset');
            await updateUtcOffset(context.params.documentId, data.parameters);
        }
    });

exports.updateEmailVerifiedHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        if (data.functionName === 'updateEmailVerified') {
            const updateEmailVerified = require('./updateEmailVerified');
            await updateEmailVerified(context.params.documentId, data.parameters);
        }
    });

exports.resizeImageHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        if (data.functionName === 'resizeImage') {
            const resizeImage = require('./resizeImage');
            await resizeImage(context.params.documentId, data.parameters, bucketName);
        }
    });

exports.pinataHandler = functions.firestore
.document('functionCalls/{documentId}')
.onCreate(async (snap, context) => {
    const data = snap.data();
    if (data.functionName === 'pinata') {
        const pinata = require('./pinata');
        await pinata(context.params.documentId, data.parameters, bucketName, vertexProject, vertexLocation);
    }
});

exports.followHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        if (data.functionName === 'follow') {
            const follow = require('./follow');
            await follow(context.params.documentId, data.parameters);
        }
    });

    exports.tokenizePostHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        if (data.functionName === 'tokenizePost') {
            const tokenizePost = require('./tokenizePost');
            await tokenizePost(context.params.documentId, data.parameters);
        }
    });

    exports.feedCollectHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        if (data.functionName === 'feedCollect') {
            const feedCollect = require('./feedCollect');
            await feedCollect(context.params.documentId, data.parameters);
        }
    });

    exports.updateFeedTxnCollectorHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        if (data.functionName === 'updateFeedTxnCollector') {
            const updateFeedTxnCollector = require('./updateFeedTxnCollector');
            await updateFeedTxnCollector(context.params.documentId, data.parameters);
        }
    });

    exports.postOpenGraphHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        if (data.functionName === 'postOpenGraph') {
            const postOpenGraph = require('./postOpenGraph');
            await postOpenGraph(context.params.documentId, data.parameters);
        }
    });
