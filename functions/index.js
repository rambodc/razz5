const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { VertexAI } = require('@google-cloud/vertexai');

admin.initializeApp();

// Correctly initialize Vertex AI with your Cloud project and location
const vertexAI = new VertexAI({ project: 'razz5-14781', location: 'us-central1' });
const generativeModel = vertexAI.preview.getGenerativeModel({
    model: 'gemini-1.5-flash-001',
    generationConfig: {
        'maxOutputTokens': 8192,
        'temperature': 1,
        'topP': 0.95,
    },
    safetySettings: [
        {
            'category': 'HARM_CATEGORY_HATE_SPEECH',
            'threshold': 'BLOCK_MEDIUM_AND_ABOVE'
        },
        {
            'category': 'HARM_CATEGORY_DANGEROUS_CONTENT',
            'threshold': 'BLOCK_MEDIUM_AND_ABOVE'
        },
        {
            'category': 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
            'threshold': 'BLOCK_MEDIUM_AND_ABOVE'
        },
        {
            'category': 'HARM_CATEGORY_HARASSMENT',
            'threshold': 'BLOCK_MEDIUM_AND_ABOVE'
        }
    ],
});

// Global bucket name
const bucketName = 'razz5-14781';

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
                await func(documentId, parameters, generativeModel, bucketName);
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
            await inviteRequest(context.params.documentId, data.parameters, generativeModel, bucketName);
        }
    });

exports.transactionsHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        if (data.functionName === 'transactions') {
            const transactions = require('./transactions');
            await transactions(context.params.documentId, data.parameters, generativeModel, bucketName);
        }
    });

exports.followHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        if (data.functionName === 'follow') {
            const follow = require('./follow');
            await follow(context.params.documentId, data.parameters, generativeModel, bucketName);
        }
    });

exports.unfollowHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        if (data.functionName === 'unfollow') {
            const unfollow = require('./unfollow');
            await unfollow(context.params.documentId, data.parameters, generativeModel, bucketName);
        }
    });

exports.userSetupHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        if (data.functionName === 'userSetup') {
            const userSetup = require('./userSetup');
            await userSetup(context.params.documentId, data.parameters, generativeModel, bucketName);
        }
    });

exports.runAIHandler = functions.firestore
    .document('functionCalls/{documentId}')
    .onCreate(async (snap, context) => {
        const data = snap.data();
        if (data.functionName === 'runAI') {
            const runAI = require('./runAI');
            await runAI(context.params.documentId, data.parameters, generativeModel, bucketName);
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
