const mongoose = require("mongoose");

const questionSchema = mongoose.Schema({
  word: { type: String, required: true },            // the vocabulary word being tested
  vocab_id: { type: String },
  kind: { type: String, enum: ["meaning", "sentence", "synonym", "antonym"], required: true },
  prompt: { type: String, required: true },
  options: { type: [String], default: [] },          // empty => the user types the answer
  correct_answer: { type: String, required: true },  // never sent to the client before submit
  explanation: { type: String, default: "" },
});

const answerSchema = mongoose.Schema(
  {
    question_id: { type: String, required: true },
    selected: { type: String, default: null },
    is_correct: { type: Boolean, required: true },
  },
  { _id: false },
);

const schema = mongoose.Schema(
  {
    user_id: { type: String, required: true, index: true },
    mode: { type: String, enum: ["weak", "all", "words"], required: true },
    source_words: { type: [String], default: [] },
    questions: { type: [questionSchema], required: true },
    answers: { type: [answerSchema], default: [] },
    total: { type: Number, required: true },
    score: { type: Number, default: 0 },
    status: { type: String, enum: ["pending", "submitted"], default: "pending" },
    ai_generated: { type: Boolean, default: false },
    submitted_at: { type: Date },
  },
  { timestamps: true },
);

module.exports = mongoose.model("test", schema);
