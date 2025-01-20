const functions = require('firebase-functions');
const admin = require('firebase-admin');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { createCanvas } = require('canvas');

// Only initialize Firebase Admin if it hasn't been initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

// Initialize Google Cloud Storage with project ID from environment variables

const { Storage } = require('@google-cloud/storage');
const storage = new Storage({ projectId: functions.config().project_id });

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

    const { uid, post_id, file_format } = req.body;

    if (!uid || !post_id || !file_format) {
        res.status(400).send("Missing required parameters: uid, post_id, or file_format");
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
        await actions_ref.update({
            "general.total_actions_today": total_actions_today
        });

        return { proceed: true, uid, post_id, file_format };
    } catch (error) {
        console.error(`Error during initialization and checks: ${error.message}`);
        res.status(500).send({ status: "error", message: error.message });
        return { proceed: false };
    }
}

module.exports.v1_video_thumbnail = functions.https.onRequest(async (req, res) => {
    const init_result = await initializeAndCheck(req, res);
    if (!init_result.proceed) {
        return;
    }

    const { uid, post_id } = init_result;

    // Add UID Check
    const postRef = admin.firestore().collection('posts').doc(post_id);
    const postDoc = await postRef.get();

    if (!postDoc.exists) {
        res.status(404).send({
            status: "error",
            message: "Post not found"
        });
        return;
    }

    const postData = postDoc.data();
    if (postData.general?.uid !== uid) {
        res.status(403).send({
            status: "error",
            message: "Unauthorized: UID mismatch with post owner"
        });
        return;
    }

    const bucket_name = functions.config().storage.bucket;
    const bucket = storage.bucket(bucket_name);
    const resized_file_path = `posts/${post_id}/resized/${post_id}_resized.mp4`;
    const temp_resized_file_path = path.join(os.tmpdir(), `${post_id}_resized.mp4`);

    try {
        const file = bucket.file(resized_file_path);
        const [exists] = await file.exists();
        if (!exists) {
            throw new Error(`File not found at path: ${resized_file_path}`);
        }

        await file.download({ destination: temp_resized_file_path });
        console.log(`Resized video downloaded to temporary path: ${temp_resized_file_path}`);

        const duration = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(temp_resized_file_path, (err, metadata) => {
                if (err) reject(err);
                else resolve(metadata.format.duration);
            });
        });

        console.log(`Video duration: ${duration} seconds`);

        const timemarks = [0.1, 0.3, 0.5, 0.8].map((fraction) => (fraction * duration).toFixed(1));
        const thumbnails = timemarks.map((time, index) => {
            const suffix = index === 0 ? `_resized.png` : `_resized${index}.png`;
            return { suffix, timemark: time };
        });
        
        if (duration >= 3) {
            thumbnails.push({ suffix: '_resized.gif', timemark: '0', gif: true });
        }
        

        let lastThumbnailSuffix = '';

        for (const thumbnail of thumbnails) {
            const thumbnail_path = path.join(os.tmpdir(), `${post_id}${thumbnail.suffix}`);

            await new Promise((resolve, reject) => {
                const ffmpegProcess = ffmpeg(temp_resized_file_path);
                if (thumbnail.gif) {
                    ffmpegProcess
                        .output(thumbnail_path)
                        .outputOptions(['-vf', "fps=10,scale=320:-1:flags=lanczos", '-t', '3'])
                        .on('end', resolve)
                        .on('error', reject)
                        .run();
                } else {
                    ffmpegProcess
                        .screenshots({
                            count: 1,
                            timemarks: [thumbnail.timemark],
                            filename: `${post_id}${thumbnail.suffix}`,
                            folder: os.tmpdir(),
                        })
                        .on('end', resolve)
                        .on('error', reject);
                }
            });

            lastThumbnailSuffix = thumbnail.suffix;

            const thumbnail_storage_path = `posts/${post_id}/resized/${post_id}${thumbnail.suffix}`;
            console.log(`Uploading thumbnail to: ${thumbnail_storage_path}`);
            await bucket.upload(thumbnail_path, {
                destination: thumbnail_storage_path,
                metadata: {
                    contentType: thumbnail.gif ? 'image/gif' : 'image/png',
                },
            });

            if (fs.existsSync(thumbnail_path)) {
                fs.unlinkSync(thumbnail_path);
                console.log(`Temporary thumbnail deleted: ${thumbnail_path}`);
            }
        }

        console.log(`Last thumbnail saved: ${lastThumbnailSuffix}`);

        await admin.firestore().collection('posts').doc(post_id).set({
            resized: {
                video_poster: lastThumbnailSuffix
            }
        }, { merge: true });

        res.status(200).send({
            status: "success",
            message: "Thumbnails created and uploaded successfully",
        });
    } catch (error) {
        console.error(`Error in v1_video_thumbnail function: ${error.message}`);
        res.status(500).send({
            status: "error",
            message: error.message,
        });
    } finally {
        try {
            if (fs.existsSync(temp_resized_file_path)) {
                fs.unlinkSync(temp_resized_file_path);
                console.log(`Temporary resized file deleted: ${temp_resized_file_path}`);
            }
        } catch (cleanupError) {
            console.warn(`Error during cleanup: ${cleanupError.message}`);
        }
    }
});

