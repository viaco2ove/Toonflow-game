import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();
const VIDEO_DEBUG = (process.env.AI_VIDEO_DEBUG || "").trim() === "1";
interface TempAsset {
  videoId: number;
  filePath: string;
  type: string;
}

// 获取视频
export default router.post(
  "/",
  validateFields({
    scriptId: z.number(),
    specifyIds: z
      .preprocess((value) => {
        if (typeof value === "number") return [value];
        return value;
      }, z.array(z.number()))
      .optional(),
  }),
  async (req, res) => {
    const { scriptId, specifyIds } = req.body;
    if (VIDEO_DEBUG) {
      console.log("[video] /video/getVideo request", {
        scriptId,
        specifyIdsCount: Array.isArray(specifyIds) ? specifyIds.length : 0,
      });
    }

    const videos = await u
      .db("t_video")
      .where("scriptId", scriptId)
      .modify((qb) => {
        if (specifyIds && specifyIds.length) {
          qb.whereIn("id", specifyIds);
        }
      })
      .select("id", "configId", "time", "resolution", "prompt", "firstFrame", "filePath", "storyboardImgs", "model", "scriptId", "state","errorReason");
    // const videoIds: number[] = videos.map((video: any) => (typeof video.id === "string" ? parseInt(video.id) : video.id));

    // let tempAssets: TempAsset[] = await u
    //   .db("t_tempAssets")
    //   .whereIn("videoId", videoIds)
    //   .whereNot("filePath", "")
    //   .select("videoId", "filePath", "type");

    // tempAssets = await Promise.all(
    //   tempAssets.map(async (asset) => {
    //     const signedFilePath = asset.filePath ? await u.oss.getFileUrl(asset.filePath) : "";
    //     return {
    //       ...asset,
    //       filePath: signedFilePath,
    //     };
    //   })
    // );

    // const tempAssetsMap: Record<number, TempAsset[]> = {};
    // tempAssets.forEach((asset) => {
    //   if (!tempAssetsMap[asset.videoId]) {
    //     tempAssetsMap[asset.videoId] = [];
    //   }
    //   tempAssetsMap[asset.videoId]!.push(asset);
    // });

    const data = await Promise.all(
      videos.map(async (video: any) => {
        let storyboardImgs: string[] = [];
        if (video.storyboardImgs) {
          try {
            storyboardImgs = Array.isArray(video.storyboardImgs) ? video.storyboardImgs : JSON.parse(video.storyboardImgs);
          } catch (err) {
            storyboardImgs = [];
          }
        }
        const signedStoryboardImgs = await Promise.all(storyboardImgs.map((img) => (img ? u.oss.getFileUrl(img) : "")));
        const signedFilePath = video.filePath ? await u.oss.getFileUrl(video.filePath) : "";
        const signedFirstFrame = video.firstFrame ? await u.oss.getFileUrl(video.firstFrame) : "";
        const videoId = typeof video.id === "string" ? parseInt(video.id) : video.id;
        return {
          ...video,
          filePath: signedFilePath,
          firstFrame: signedFirstFrame,
          storyboardImgs: signedStoryboardImgs,
          // tempAssets: tempAssetsMap[videoId] || [],
        };
      }),
    );
    if (VIDEO_DEBUG) {
      console.log("[video] /video/getVideo response", {
        scriptId,
        resultCount: data.length,
      });
    }
    res.status(200).send(success(data));
  },
);
