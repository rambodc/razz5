// Firebase Cloud Function: v1_resize_file_audio_support.js
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

// General initialization and checks for all functions
async function initialize_and_check(req, res) {
    // Set CORS headers for preflight requests
    const allowed_origin = functions.config().cors.origin || '*';
    res.set('Access-Control-Allow-Origin', allowed_origin);
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === "OPTIONS") {
        // Handle preflight request
        res.status(204).send('');
        return { proceed: false };
    }

    if (req.method !== "POST") {
        res.status(405).send("Method Not Allowed");
        return { proceed: false };
    }

    // Extract necessary parameters from the request body
    const { uid, post_id } = req.body;

    if (!uid || !post_id) {
        res.status(400).send("Missing required parameters: uid or post_id");
        return { proceed: false };
    }

    const user_ref = admin.firestore().collection('users').doc(uid);
    const actions_ref = admin.firestore().collection('actions').doc(uid);

    try {
        // Verify custom claims for the user
        const user_record = await admin.auth().getUser(uid);
        const custom_claims = user_record.customClaims;
        if (!custom_claims || (custom_claims.user_type !== 'user' && custom_claims.user_type !== 'admin') || custom_claims.user_status !== 'active') {
            res.status(403).send({ status: "error", message: "Unauthorized: User does not have the required permissions" });
            return { proceed: false };
        }

        // General action check before proceeding
        const actions_doc = await actions_ref.get();
        if (!actions_doc.exists) {
            throw new Error('Actions document does not exist.');
        }

        const actions_data = actions_doc.data();
        const current_time = new Date();
        const reset_global_action_at = actions_data.general.reset_global_action_at;
        let total_actions_today = actions_data.general.total_actions_today;
        const daily_limit = actions_data.general.daily_limit;

        // Convert Firestore timestamp to JavaScript Date
        const reset_global_action_at_date = new Date(reset_global_action_at.seconds * 1000);

        // Check if 24 hours have passed since the last reset
        if (current_time - reset_global_action_at_date > 24 * 60 * 60 * 1000) {
            // Reset total_actions_today and update reset_global_action_at
            total_actions_today = 0;
            await actions_ref.update({
                "general.total_actions_today": total_actions_today,
                "general.reset_global_action_at": admin.firestore.Timestamp.now()
            });
        }

        // Check if the user has exceeded the daily limit
        if (total_actions_today >= daily_limit) {
            res.status(429).send({ status: "error", message: "Daily action limit exceeded" });
            return { proceed: false };
        }

        // Increment the total actions count
        total_actions_today += 1;

        // Update the actions document with the new values
        await actions_ref.update({
            "general.total_actions_today": total_actions_today
        });

        return { proceed: true, uid, post_id };
    } catch (error) {
        console.error(`Error during initialization and checks: ${error.message}`);
        res.status(500).send({ status: "error", message: error.message });
        return { proceed: false };
    }
}

module.exports.v1_resize_file = functions.https.onRequest(async (req, res) => {
    const init_result = await initialize_and_check(req, res);
    if (!init_result.proceed) {
        return;
    }

    const { uid, post_id } = init_result;

    const bucket_name = functions.config().storage.bucket;
    const bucket = storage.bucket(bucket_name);
    const original_file_path = `posts/${post_id}/original/${post_id}_original`;
    const temp_original_file_path = path.join(os.tmpdir(), `${post_id}_original`);
    const metadata_file_path = `posts/${post_id}/resized/resized_metadata.json`;

    let metadata = {
        post_id: post_id,
        status: "in-progress",
        attempts: 0,
        resized_files: [],
        error_logs: []
    };

    try {
        // Attempt to load existing metadata if it exists
        const [metadataExists] = await bucket.file(metadata_file_path).exists();
        if (metadataExists) {
            const metadataBuffer = await bucket.file(metadata_file_path).download();
            metadata = JSON.parse(metadataBuffer.toString());
        }

        // Increment attempt count and update status
        metadata.attempts += 1;
        metadata.status = "in-progress";
        await bucket.file(metadata_file_path).save(JSON.stringify(metadata), {
            contentType: 'application/json'
        });

        console.log("Reconstructing file path from Cloud Storage");
        const file = bucket.file(original_file_path);
        console.log(`Attempting to download file from path: ${original_file_path}`);

        // Check if the file exists before downloading
        const [exists] = await file.exists();
        if (!exists) {
            throw new Error(`File not found at path: ${original_file_path}`);
        }

        await file.download({ destination: temp_original_file_path });
        console.log("File downloaded successfully");

        // Use FFmpeg to determine file type
        console.log("Determining file type using FFmpeg");
        let hasVideoStream = false;
        let hasAudioStream = false;
        await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(temp_original_file_path, (err, metadata) => {
                if (err) {
                    console.error('Error while probing file:', err);
                    reject(new Error('Unable to determine file type using FFmpeg'));
                } else {
                    console.log('File metadata:', metadata);
                    if (metadata.streams) {
                        const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
                        if (videoStream) {
                            hasVideoStream = true;
                        }
                        hasAudioStream = metadata.streams.some(stream => stream.codec_type === 'audio');
                    }
                    resolve();
                }
            });
        });

        let resized_paths = [];

        if (hasVideoStream) {
            console.log("Resizing video file with adaptive scaling to maintain aspect ratio");

            // Resize video while maintaining aspect ratio, fitting within 1920x1080 max bounds
            const resized_file_path = path.join(os.tmpdir(), `${post_id}_resized.mp4`);
            await new Promise((resolve, reject) => {
                ffmpeg(temp_original_file_path)
                    .videoCodec('libx264')
                    .audioCodec('aac')
                    .outputOptions([
                        '-vf', "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease",
                        '-preset', 'slow',
                        '-crf', '23',
                        '-pix_fmt', 'yuv420p' // Ensures compatibility with most players
                    ])
                    .output(resized_file_path)
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
            });

            console.log("Uploading resized video to Cloud Storage");
            const resized_storage_path = `posts/${post_id}/resized/${post_id}_resized.mp4`;
            await bucket.upload(resized_file_path, {
                destination: resized_storage_path,
                metadata: {
                    contentType: 'video/mp4'
                }
            });

            console.log("Resized video uploaded successfully");
            resized_paths.push(resized_storage_path);
            metadata.resized_files.push({
                file_name: `${post_id}_resized.mp4`,
                type: "video",
                status: "success"
            });
        } 

        if (hasAudioStream && !hasVideoStream) {
            console.log("Processing audio file to convert to mp3 format");

            // Convert to mp3 format
            const resized_audio_file_path = path.join(os.tmpdir(), `${post_id}_audio.mp3`);
            await new Promise((resolve, reject) => {
                ffmpeg(temp_original_file_path)
                    .outputOptions('-q:a', '2') // High quality audio
                    .output(resized_audio_file_path)
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
            });

            console.log("Uploading mp3 audio to Cloud Storage");
            const resized_audio_storage_path = `posts/${post_id}/resized/${post_id}_audio.mp3`;
            await bucket.upload(resized_audio_file_path, {
                destination: resized_audio_storage_path,
                metadata: {
                    contentType: 'audio/mpeg'
                }
            });

            console.log("Audio file converted and uploaded successfully");
            resized_paths.push(resized_audio_storage_path);
            metadata.resized_files.push({
                file_name: `${post_id}_audio.mp3`,
                type: "audio",
                status: "success"
            });
        } 

        if (!hasVideoStream && !hasAudioStream) {
            throw new Error('Unsupported file type for resizing: No video or audio stream found');
        }

        // Update metadata file with success status
        metadata.status = "completed";
        await bucket.file(metadata_file_path).save(JSON.stringify(metadata), {
            contentType: 'application/json'
        });

        res.status(200).send({ status: "success", message: "File processed and uploaded successfully", resized_paths });
    } catch (error) {
        console.error(`Error in v1_resize_file function: ${error.message}`);

        // Update metadata file with failure status and error log
        metadata.status = "failed";
        metadata.error_logs.push({
            attempt: metadata.attempts,
            message: error.message,
            timestamp: new Date().toISOString()
        });

        // Create thumbnail image on failure
        const canvas = createCanvas(800, 800);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#808080'; // Gray background
        ctx.fillRect(0, 0, 800, 800);
        ctx.fillStyle = '#FFFFFF'; // White text
        ctx.font = 'bold 80px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(path.extname(temp_original_file_path).slice(1).toUpperCase(), 400, 400);

        const thumbnail_path = path.join(os.tmpdir(), `${post_id}_800x800.png`);
        const buffer = canvas.toBuffer('image/png');
        fs.writeFileSync(thumbnail_path, buffer);

        const thumbnail_storage_path = `posts/${post_id}/resized/${post_id}_800x800.png`;
        await bucket.upload(thumbnail_path, {
            destination: thumbnail_storage_path,
            metadata: {
                contentType: 'image/png'
            }
        });

        metadata.resized_files.push({
            file_name: `${post_id}_800x800.png`,
            type: "thumbnail",
            status: "created_on_failure"
        });

        await bucket.file(metadata_file_path).save(JSON.stringify(metadata), {
            contentType: 'application/json'
        });

        res.status(500).send({ status: "error", message: error.message });
    }
});
