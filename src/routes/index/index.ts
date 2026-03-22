import express from "express";
const router = express.Router();

export default router.get("/", async (req, res, next) => {
  res.status(200).send(123);
});
