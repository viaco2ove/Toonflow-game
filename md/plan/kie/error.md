[video] invoke {
  manufacturer: 'kieai',
  model: 'veo3_fast',
  baseURL: 'https://api.kie.ai/api/v1/veo/generate|https://api.kie.ai/api/v1/veo/record-info?taskId={taskId}',
  apiKey: '9ca5***6f4b',
  imageCount: 2,
  duration: 4,
  resolution: '720p',
  mode: 'startEnd'
}
POST /video/getVideo 200 7.999 ms - 112640
POST /video/getVideo 200 2.560 ms - 900
POST /video/getVideo 200 7.806 ms - 112640
[TEMP_OSS] upload failed: Client network socket disconnected before secure TLS connection was established
POST /video/getVideo 200 3.551 ms - 900
POST /video/getVideo 200 1.926 ms - 900
[video:kieai] submit request: {"submitUrl":"https://api.kie.ai/api/v1/veo/generate","queryUrl":"https://api.kie.ai/api/v1/veo/record-info?taskId={taskId}","model":"veo3_fast","apiKey":"9ca5***6f4b","promptLength":356,"imageCount":2,"aspectRatio":"16:9","resolution":"720p","duration":4,"generationType":"REFERENCE_2_VIDEO"}       
[video:kieai] submit response: {"httpStatus":200,"requestId":"","taskId":"8528e21f1c825fb434ce5be11d6f6cc7","error":"success"}
OPTIONS /video/getVideo 204 0.074 ms - 0
POST /video/getVideo 200 2.229 ms - 900
POST /video/getVideo 200 2.770 ms - 900
OPTIONS /video/getVideo 204 0.070 ms - 0
POST /video/getVideo 200 3.186 ms - 900
POST /video/getVideo 200 2.325 ms - 900
OPTIONS /video/getVideo 204 0.060 ms - 0
POST /video/getVideo 200 1.454 ms - 900
[video:kieai] poll response #1: {"httpStatus":200,"requestId":"","status":"PENDING","hasUrl":false,"error":"Image fetch failed. Check access settings or use our File Upload API instead."}
[video:kieai:veo3_fast] attempt 1/500 status=FAILED completed=false hasUrl=false
video generation failed videoId=281: Error: Image fetch failed. Check access settings or use our File Upload API instead.
    at pollTask (D:\Users\viaco\tools\toonflow-app-run\src\utils\ai\utils.ts:94:22)
    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    at async Object.default (D:\Users\viaco\tools\toonflow-app-run\src\utils\ai\video\index.ts:87:18)
    at async generateVideoAsync (D:\Users\viaco\tools\toonflow-app-run\src\routes\video\generateVideo.ts:293:23)
POST /video/getVideo 200 2.176 ms - 976
OPTIONS /video/upDateVideoConfig 204 0.075 ms - 0
POST /video/upDateVideoConfig 200 5.930 ms - 1153
OPTIONS /video/generateVideo 204 0.063 ms - 0
[video] /video/generateVideo request {
