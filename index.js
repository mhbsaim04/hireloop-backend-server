import express from 'express';
import cors from 'cors';
import 'dotenv/config'
import { MongoClient, ObjectId } from 'mongodb';


const app = express();
const port = process.env.PORT || 7000;

const allowedOrigins = new Set(
  (
    process.env.CLIENT_ORIGINS ||
    "http://localhost:3000,http://127.0.0.1:3000"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

app.use(express.json());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Origin is not allowed by CORS"));
    },
    credentials: true,
  })
);

if (!process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI must be configured");
}

const client = new MongoClient(process.env.MONGODB_URI);
export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.error("Failed to connect to MongoDB:", err);
    throw err;
  }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db("hireloop-db");
const users = database.collection("user");
const jobs = database.collection("jobs");
const companies = database.collection("companies");
const applications = database.collection("applications");
const applicationUsage = database.collection("applicationUsage");

await applications.createIndex({ userId: 1, jobId: 1 }, { unique: true });
await applications.createIndex({ userId: 1, appliedAt: -1 });
await applicationUsage.createIndex({ userId: 1, period: 1 }, { unique: true });

async function requireAuthenticatedUser(req, res, next) {
  if (!req.headers.cookie) {
    return res.status(401).json({ error: "Sign in to continue." });
  }

  if (!process.env.BETTER_AUTH_URL) {
    return res
      .status(503)
      .json({ error: "Authentication verification is not configured." });
  }

  try {
    const sessionUrl = new URL(
      "/api/auth/get-session",
      process.env.BETTER_AUTH_URL
    );
    const sessionResponse = await fetch(sessionUrl, {
      headers: {
        accept: "application/json",
        cookie: req.headers.cookie,
      },
      cache: "no-store",
    });

    if (!sessionResponse.ok) {
      console.error(
        "Better Auth session verification returned",
        sessionResponse.status
      );
      return res
        .status(503)
        .json({ error: "Could not verify your sign-in. Please try again." });
    }

    const sessionData = await sessionResponse.json();
    if (!sessionData?.user?.id) {
      return res.status(401).json({ error: "Sign in to continue." });
    }

    req.authUser = sessionData.user;
    return next();
  } catch (err) {
    console.error("Failed to verify Better Auth session:", err);
    return res
      .status(503)
      .json({ error: "Could not verify your sign-in. Please try again." });
  }
}

async function reserveApplicationUsage(userId, period, plan) {
  const limit = plan === "free" ? 27 : null;
  const filter = { userId, period };
  if (limit !== null) filter.count = { $lt: limit };

  try {
    const result = await applicationUsage.updateOne(
      filter,
      {
        $inc: { count: 1 },
        $set: { plan, updatedAt: new Date() },
        $setOnInsert: { userId, period, createdAt: new Date() },
      },
      { upsert: true }
    );

    if (!result.matchedCount && !result.upsertedCount) {
      const currentUsage = await applicationUsage.findOne({ userId, period });
      return {
        allowed: false,
        used: currentUsage?.count ?? limit,
        limit,
      };
    }
  } catch (err) {
    if (err?.code !== 11000) throw err;

    const retry = await applicationUsage.updateOne(
      filter,
      {
        $inc: { count: 1 },
        $set: { plan, updatedAt: new Date() },
      }
    );

    if (!retry.matchedCount) {
      const currentUsage = await applicationUsage.findOne({ userId, period });
      return {
        allowed: false,
        used: currentUsage?.count ?? limit,
        limit,
      };
    }
  }

  const currentUsage = await applicationUsage.findOne({ userId, period });
  return {
    allowed: true,
    used: currentUsage?.count ?? 1,
    limit,
  };
}

async function releaseApplicationUsage(userId, period) {
  try {
    await applicationUsage.updateOne(
      { userId, period, count: { $gt: 0 } },
      { $inc: { count: -1 }, $set: { updatedAt: new Date() } }
    );
  } catch (err) {
    console.error("Failed to release application usage reservation:", err);
  }
}

function serializeApplication(application) {
  const { _id, jobId, ...fields } = application;
  const appliedAt =
    application.appliedAt instanceof Date
      ? application.appliedAt.toISOString()
      : application.appliedAt;

  return {
    ...fields,
    id: _id.toString(),
    jobId: jobId.toString(),
    appliedAt,
  };
}


app.get('/', (req, res) => {
  res.send('The Hireloop backend is operating smoothly and efficiently!!');
});

app.get('/users', async(req, res) =>{
  const cursor = users.find({});
  const result = await cursor.toArray();
  res.send(result);
})

// Jobs related APIs
app.post('/jobs', async (req, res) =>{
  const job = req.body;
  const result = await jobs.insertOne(job);
  // Return the saved document (including _id) so the client can use it right away.
  res.send({ ...job, _id: result.insertedId });
})

app.get("/jobs", async (req, res) => {
  try {
    const { q, category, location, type, minSalary, requirements } = req.query;
    const filter = {};
    if (q) {
      const regex = new RegExp(q, "i");
      filter.$or = [
        { title: regex },
        { company: regex },
        { category: regex },
        { location: regex },
      ];
    }
    if (category && category !== "All") filter.category = category;
    if (location && location !== "All") filter.location = location;
    if (type && type !== "All") filter.jobType = type;
    if (minSalary) filter.minSalary = { $gte: Number(minSalary) };
    if (requirements) filter.requirements = new RegExp(requirements, "i");
    const cursor = jobs.find(filter);
    const result = await cursor.toArray();
    res.send(result);
  } catch (err) {
    res.status(500).send({ error: "Failed to load jobs" });
  }
});

app.get("/jobs/:id", async (req, res) => {
  try {
    const job = await jobs.findOne({ _id: new ObjectId(req.params.id) });
    if (!job) return res.status(404).send({ error: "Job not found" });
    res.send(job);
  } catch (err) {
    res.status(400).send({ error: "Invalid job id" });
  }
});

// Seeker applications
app.post("/applications", requireAuthenticatedUser, async (req, res) => {
  const userId = req.authUser.id;
  const body = req.body ?? {};
  const { jobId, coverLetter } = body;

  if (req.authUser.role && req.authUser.role !== "seeker") {
    return res.status(403).json({
      code: "SEEKER_ACCOUNT_REQUIRED",
      error: "Only seeker accounts can apply to jobs.",
    });
  }
  if (typeof jobId !== "string" || !ObjectId.isValid(jobId)) {
    return res.status(400).json({
      code: "INVALID_JOB_ID",
      error: "A valid job ID is required.",
    });
  }
  if (
    coverLetter !== undefined &&
    (typeof coverLetter !== "string" || coverLetter.length > 5000)
  ) {
    return res.status(400).json({
      code: "INVALID_COVER_LETTER",
      error: "Cover letters must be 5,000 characters or fewer.",
    });
  }

  try {
    const account = await users.findOne(
      { _id: userId },
      { projection: { role: 1, plan: 1 } }
    );
    if (!account) {
      return res.status(401).json({ error: "Your account could not be found." });
    }

    if (account.role && account.role !== "seeker") {
      return res.status(403).json({
        code: "SEEKER_ACCOUNT_REQUIRED",
        error: "Only seeker accounts can apply to jobs.",
      });
    }

    const jobObjectId = new ObjectId(jobId);
    const job = await jobs.findOne({ _id: jobObjectId });
    if (!job) {
      return res.status(404).json({
        code: "JOB_NOT_FOUND",
        error: "This job is no longer available.",
      });
    }

    const existingApplication = await applications.findOne({
      userId,
      jobId: jobObjectId,
    });
    if (existingApplication) {
      return res.status(200).json({
        application: serializeApplication(existingApplication),
        alreadyApplied: true,
      });
    }

    const accountPlan = String(account.plan ?? req.authUser.plan ?? "free")
      .toLowerCase();
    const plan = ["growth", "premium"].includes(accountPlan)
      ? accountPlan
      : "free";
    const now = new Date();
    const period = `${now.getUTCFullYear()}-${String(
      now.getUTCMonth() + 1
    ).padStart(2, "0")}`;
    const usage = await reserveApplicationUsage(userId, period, plan);

    if (!usage.allowed) {
      return res.status(429).json({
        code: "APPLICATION_LIMIT_REACHED",
        error: `The Free plan allows up to ${usage.limit} applications per month.`,
        used: usage.used,
        limit: usage.limit,
        plan,
      });
    }

    const application = {
      userId,
      applicantName: req.authUser.name ?? "",
      applicantEmail: req.authUser.email ?? "",
      jobId: jobObjectId,
      jobTitle: job.title ?? "Untitled job",
      company: job.company ?? "Company",
      location: job.location ?? "",
      minSalary: job.minSalary ?? null,
      maxSalary: job.maxSalary ?? null,
      frequency: job.frequency ?? "",
      coverLetter: typeof coverLetter === "string" ? coverLetter.trim() : "",
      status: "Applied",
      appliedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    try {
      const result = await applications.insertOne(application);
      return res.status(201).json({
        application: serializeApplication({
          ...application,
          _id: result.insertedId,
        }),
        alreadyApplied: false,
        usage: {
          plan,
          used: usage.used,
          limit: usage.limit,
          remaining:
            usage.limit === null
              ? null
              : Math.max(usage.limit - usage.used, 0),
        },
      });
    } catch (err) {
      await releaseApplicationUsage(userId, period);
      if (err?.code === 11000) {
        const duplicate = await applications.findOne({ userId, jobId: jobObjectId });
        if (duplicate) {
          return res.status(200).json({
            application: serializeApplication(duplicate),
            alreadyApplied: true,
          });
        }
      }
      throw err;
    }
  } catch (err) {
    console.error("Failed to save job application:", err);
    return res.status(500).json({
      code: "APPLICATION_SAVE_FAILED",
      error: "Could not save your application. Please try again.",
    });
  }
});

app.get("/applications/me", requireAuthenticatedUser, async (req, res) => {
  if (req.authUser.role && req.authUser.role !== "seeker") {
    return res.status(403).json({
      code: "SEEKER_ACCOUNT_REQUIRED",
      error: "Only seeker accounts can view job applications.",
    });
  }

  try {
    const result = await applications
      .find({ userId: req.authUser.id })
      .sort({ appliedAt: -1 })
      .toArray();
    return res.json(result.map(serializeApplication));
  } catch (err) {
    console.error("Failed to load seeker applications:", err);
    return res.status(500).json({
      error: "Could not load your applications. Please try again.",
    });
  }
});

//  app.delete('/jobs/:id', async(req, res) =>{
//   const id = req.params.id;
//   const query = {_id: new ObjectId(id)};
//   const result = await jobs. deleteOne(query);
//   res.send(result);
//    })

app.delete('/jobs/:id', async (req, res) => {
  try {
    const result = await jobs.deleteOne({ _id: new ObjectId(req.params.id) });
    res.send(result);
  } catch (err) {
    res.status(400).send({ error: 'Invalid job id' });
  }
});

// Companies related APIs
app.get('/companies', async (req, res) => {
  try {
    const cursor = companies.find({});
    const result = await cursor.toArray();
    res.send(result);
  } catch (err) {
    res.status(500).send({ error: 'Failed to load companies' });
  }
});

app.get('/companies/:id', async (req, res) => {
  try {
    const company = await companies.findOne({ _id: new ObjectId(req.params.id) });
    if (!company) return res.status(404).send({ error: 'Company not found' });
    res.send(company);
  } catch (err) {
    res.status(400).send({ error: 'Invalid company id' });
  }
});

app.post('/companies', async (req, res) => {
  try {
    const company = { ...req.body, status: 'Pending', createdAt: new Date().toISOString() };
    const result = await companies.insertOne(company);
    res.send({ ...company, _id: result.insertedId });
  } catch (err) {
    res.status(500).send({ error: 'Failed to create company' });
  }
});

app.put('/companies/:id', async (req, res) => {
  try {
    const { _id, ...updates } = req.body;
    const result = await companies.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { ...updates, status: 'Pending' } }
    );
    const company = await companies.findOne({ _id: new ObjectId(req.params.id) });
    res.send(company);
  } catch (err) {
    res.status(400).send({ error: 'Invalid company id' });
  }
});

// Admin: update company status
app.patch('/companies/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    await companies.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status } }
    );
    const company = await companies.findOne({ _id: new ObjectId(req.params.id) });
    res.send(company);
  } catch (err) {
    res.status(400).send({ error: 'Invalid company id' });
  }
});

app.listen(port, () => {
  console.log(`hireloop is running on port ${port}`);
});