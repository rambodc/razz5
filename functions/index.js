const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

// Central functionHandler
exports.functionHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        const functionName = data.functionName;
        const parameters = data.parameters;
        const documentId = context.params.documentId;

        try {
            const func = require(`./${functionName}`);

            if (func && typeof func === 'function') {
                await func(documentId, parameters);
            } else {
                throw new Error(`The function ${functionName} is not available or is not a valid function.`);
            }
        } catch (error) {
            console.error(`Error executing ${functionName}: ${error}`);

            await admin.firestore().collection('functionCalls').doc(documentId).update({
                'status': 'error',
                'response.errorMessage': error.message,
                'response.error': admin.firestore.FieldValue.serverTimestamp()
            });
        }
    });

// Individual function handlers
exports.inviteRequestHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        if (data.functionName === 'inviteRequest') {
            const inviteRequest = require('./inviteRequest');
            await inviteRequest(context.params.documentId, data.parameters);
        }
    });

exports.transactionsHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        if (data.functionName === 'transactions') {
            const transactions = require('./transactions');
            await transactions(context.params.documentId, data.parameters);
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

exports.unfollowHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        if (data.functionName === 'unfollow') {
            const unfollow = require('./unfollow');
            await unfollow(context.params.documentId, data.parameters);
        }
    });

exports.userSetupHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        if (data.functionName === 'userSetup') {
            const userSetup = require('./userSetup');
            await userSetup(context.params.documentId, data.parameters);
        }
    });
