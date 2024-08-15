const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

const vertexProject = functions.config().vertex.project;
const vertexLocation = functions.config().vertex.location;
const bucketName = functions.config().bucket.name;

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

exports.transactionsHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        if (data.functionName === 'transactions') {
            const transactions = require('./transactions');
            await transactions(context.params.documentId, data.parameters, bucketName, vertexProject, vertexLocation);
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


exports.updatePostTitleDescHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        if (data.functionName === 'updatePostTitleDesc') {
            const updatePostTitleDesc = require('./updatePostTitleDesc');
            await updatePostTitleDesc(context.params.documentId, data.parameters);
        }
    });
