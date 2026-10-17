require("dotenv").config({
    path: require("path").join(__dirname, ".env")
});

const express = require("express");

const app = express();

const cookieParser = require('cookie-parser')

const mongoose = require("mongoose");

const path = require("path");

const PORT = process.env.PORT||3000;

const mongoDB_URL = process.env.MONGO_URL;

app.use(express.json({ limit: "100kb" }));

app.use(express.urlencoded({extended:true}));

app.use(cookieParser());

mongoose.connect(mongoDB_URL)
.then(
    ()=>{
        console.log("mongoDB connected")
    }
)
.catch(
    (e)=>
        {
            console.log(e.message)
        }
);

if (!process.env.GEMINI_API_KEY) {
    console.warn("[gemini] GEMINI_API_KEY is not set: adding words will fail and tests will use local questions only.");
}

const register = require("./routes/register.router");

const log_in = require("./routes/log_in.router");

const log_out = require("./routes/log_out.router");

const auth_me = require("./routes/auth_me.router");

const vocabluary = require("./routes/words.router");

const tests = require("./routes/test.router");

const review = require("./routes/review.router");

const { startReminderScheduler } = require("./utils/reminder_scheduler");

app.use(register);

app.use(log_in);

app.use(log_out);

app.use(auth_me);

app.use(vocabluary);

app.use(tests);

app.use(review);

// Unknown /api routes get JSON, not the HTML page.
app.use("/api", (req, res) => {
    res.status(404).json({ success: false, message: "Route not found", code: "NOT_FOUND" });
});

// Public user interface (server/public).
app.use(express.static(path.join(__dirname, "public")));

app.get("/",(req,res)=>{
    res.sendFile(path.join(__dirname,"public","index.html"))
});

app.listen(PORT,()=>{
    console.log(`http://localhost:${PORT}`);
    startReminderScheduler();
})
