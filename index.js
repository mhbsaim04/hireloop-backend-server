import express from 'express';
import cors from 'cors';
import 'dotenv/config'
import { MongoClient, ObjectId } from 'mongodb';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const app = express();
const port = process.env.PORT || 7000;
const MAX_RESUME_SIZE_BYTES = 10 * 1024 * 1024;
const FREE_APPLICATION_LIMIT = 13;

const allowedOrigins = new Set(
  (
    process.env.CLIENT_ORIGINS ||
    "http://localhost:3000,http://127.0.0.1:3000"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);
const betterAuthUrl =
  process.env.BETTER_AUTH_URL ??
  (process.env.NODE_ENV === "production"
    ? undefined
    : allowedOrigins.values().next().value);

app.use(express.json());
function parseResumePdf(req, res, next) {
  express.raw({
    type: "application/pdf",
    limit: MAX_RESUME_SIZE_BYTES,
  })(req, res, (err) => {
    if (!err) return next();
    if (err.type === "entity.too.large") {
      return res.status(413).json({
        code: "RESUME_TOO_LARGE",
        error: "Resume files must be 10 MB or smaller.",
      });
    }
    if (err.status === 400) {
      return res.status(400).json({
        code: "INVALID_RESUME_BODY",
        error: "Could not read the uploaded resume.",
      });
    }
    return next(err);
  });
}
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
const payments = database.collection("payments");
const savedJobs = database.collection("savedJobs");
const resumes = database.collection("resumes");

await applications.createIndex({ userId: 1, jobId: 1 }, { unique: true });
await applications.createIndex({ userId: 1, appliedAt: -1 });
await applications.createIndex({ jobId: 1, appliedAt: -1 });
await applicationUsage.createIndex({ userId: 1, period: 1 }, { unique: true });
await payments.createIndex({ userId: 1, createdAt: -1 });
await payments.createIndex({ sessionId: 1 }, { unique: true, sparse: true });
await payments.createIndex(
  { stripeSessionId: 1 },
  { unique: true, sparse: true }
);
await savedJobs.createIndex({ userId: 1, jobId: 1 }, { unique: true });
await savedJobs.createIndex({ userId: 1, savedAt: -1 });
await resumes.createIndex({ userId: 1 }, { unique: true });
await jobs.createIndex({ recruiterId: 1, createdAt: -1 });
await companies.createIndex({ recruiterId: 1 }, { unique: true, sparse: true });

async function requireAuthenticatedUser(req, res, next) {
  if (!req.headers.cookie) {
    return res.status(401).json({ error: "Sign in to continue." });
  }

  if (!betterAuthUrl) {
    return res
      .status(503)
      .json({
        code: "AUTH_CONFIGURATION_MISSING",
        error:
          "Authentication verification is not configured. Set BETTER_AUTH_URL to the origin serving Better Auth.",
      });
  }

  try {
    const sessionUrl = new URL("/api/auth/get-session", betterAuthUrl);
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

function requireRecruiter(req, res, next) {
  if (req.authUser?.role !== "recruiter") {
    return res.status(403).json({
      code: "RECRUITER_ACCOUNT_REQUIRED",
      error: "Only recruiter accounts can manage job posts.",
    });
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (req.authUser?.role !== "admin") {
    return res.status(403).json({
      code: "ADMIN_ACCOUNT_REQUIRED",
      error: "Only admin accounts can review company registrations.",
    });
  }
  return next();
}

function getApplicationPlan(accountPlan, sessionPlan) {
  const plan = String(accountPlan ?? sessionPlan ?? "free").toLowerCase();
  return plan === "growth" || plan === "premium" ? plan : "free";
}

function getApplicationPeriod(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function getRecruiterPlan(planValue) {
  const plan = String(planValue ?? "free").toLowerCase();
  if (plan === "growth") return "growth";
  if (plan === "enterprise" || plan === "premium") return "enterprise";
  return "free";
}

function getRecruiterJobLimit(plan) {
  if (plan === "growth") return 17;
  if (plan === "enterprise") return 50;
  return 5;
}

function isActiveJob(job, now = new Date()) {
  if (job.status) return job.status === "Active";
  if (!job.deadline) return true;
  const deadline = new Date(job.deadline);
  return Number.isNaN(deadline.getTime()) || deadline >= now;
}

async function getRecruiterJobCapacity(recruiterId) {
  const userId = ObjectId.isValid(recruiterId)
    ? new ObjectId(recruiterId)
    : recruiterId;
  const account = await users.findOne(
    { _id: userId },
    { projection: { role: 1, plan: 1 } }
  );
  if (!account) {
    const error = new Error("Your recruiter account could not be found.");
    error.code = "RECRUITER_ACCOUNT_NOT_FOUND";
    throw error;
  }
  if (account.role && account.role !== "recruiter") {
    const error = new Error("Only recruiter accounts can manage job posts.");
    error.code = "RECRUITER_ACCOUNT_REQUIRED";
    throw error;
  }

  const plan = getRecruiterPlan(account.plan);
  const limit = getRecruiterJobLimit(plan);
  const recruiterJobs = await jobs
    .find({ recruiterId }, { projection: { status: 1, deadline: 1 } })
    .toArray();
  const activeJobs = recruiterJobs.filter((job) => isActiveJob(job)).length;

  return {
    plan,
    limit,
    activeJobs,
    remaining: Math.max(limit - activeJobs, 0),
  };
}

function getApplicationLimit(plan) {
  if (plan === "free") return FREE_APPLICATION_LIMIT;
  if (plan === "growth") return 31;
  return null;
}

async function reserveApplicationUsage(userId, period, plan) {
  const limit = getApplicationLimit(plan);
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



// Payment verification and fulfillment
const CHECKOUT_PLANS = {
  seekers: {
    Pro: { plan: "growth", amountCents: 1900 },
    Premium: { plan: "premium", amountCents: 3900 },
  },
  recruiters: {
    Growth: { plan: "growth", amountCents: 4900 },
    Enterprise: { plan: "premium", amountCents: 14900 },
  },
};

app.post(
  "/payments/checkout-verify",
  requireAuthenticatedUser,
  async (req, res) => {
    const { sessionId } = req.body ?? {};
    if (
      typeof sessionId !== "string" ||
      !/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)
    ) {
      return res.status(400).json({
        success: false,
        error: "A valid Stripe Checkout session is required.",
      });
    }

    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["payment_intent"],
      });
      const metadata = session.metadata ?? {};
      const role = metadata.role;
      const audience = metadata.audience;
      const planName = metadata.planName;
      const userId = metadata.userId;

      const selectedPlan =
        role === "seekers"
          ? planName === "Pro"
            ? CHECKOUT_PLANS.seekers.Pro
            : planName === "Premium"
              ? CHECKOUT_PLANS.seekers.Premium
              : null
          : role === "recruiters"
            ? planName === "Growth"
              ? CHECKOUT_PLANS.recruiters.Growth
              : planName === "Enterprise"
                ? CHECKOUT_PLANS.recruiters.Enterprise
                : null
            : null;

      if (
        metadata.app !== "hireloop" ||
        audience !== role ||
        (role !== "seekers" && role !== "recruiters") ||
        !selectedPlan ||
        metadata.plan !== selectedPlan.plan ||
        !userId
      ) {
        return res.status(400).json({
          success: false,
          error: "This checkout session is not a valid HireLoop purchase.",
        });
      }

      const accountRole =
        role === "seekers" ? "seeker" : "recruiter";
      if (
        req.authUser.id !== userId ||
        (req.authUser.role ?? "seeker") !== accountRole
      ) {
        return res.status(403).json({
          success: false,
          error: "This checkout session does not belong to your account.",
        });
      }

      if (session.client_reference_id !== userId) {
        return res.status(400).json({
          success: false,
          error: "The Stripe checkout session account reference is invalid.",
        });
      }

      if (
        session.mode !== "subscription" ||
        session.status !== "complete" ||
        session.payment_status !== "paid" ||
        session.currency !== "usd" ||
        session.amount_total !== selectedPlan.amountCents
      ) {
        return res.status(409).json({
          success: false,
          error: "Stripe has not confirmed payment for this plan yet.",
        });
      }

      const accountId = ObjectId.isValid(userId)
        ? new ObjectId(userId)
        : userId;
      const account = await users.findOne(
        { _id: accountId },
        { projection: { role: 1 } }
      );
      if (!account) {
        return res.status(404).json({
          success: false,
          error: "The account for this payment could not be found.",
        });
      }

      const paymentIntentId =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id;
      const transactionId = paymentIntentId ?? session.id;
      const createdAt = new Date(session.created * 1000);

      await payments.updateOne(
        {
          $or: [{ sessionId }, { stripeSessionId: sessionId }, { _id: sessionId }],
        },
        {
          $setOnInsert: {
            userId,
            role: accountRole,
            plan: selectedPlan.plan,
            planName,
            amountCents: selectedPlan.amountCents,
            currency: "usd",
            sessionId,
            stripeSessionId: sessionId,
            transactionId,
            payment_intent: paymentIntentId ?? null,
            payment_status: "paid",
            status: "complete",
            customer_email: session.customer_email,
            createdAt,
            payment_date: createdAt,
          },
        },
        { upsert: true }
      );

      const activation = await users.updateOne(
        {
          _id: accountId,
          $or: [
            { billingPlanUpdatedAt: { $exists: false } },
            { billingPlanUpdatedAt: { $lte: createdAt } },
          ],
        },
        {
          $set: {
            role: accountRole,
            plan: selectedPlan.plan,
            billingPlanUpdatedAt: createdAt,
            updatedAt: new Date(),
          },
        }
      );

      return res.json({
        success: true,
        role: accountRole,
        plan: selectedPlan.plan,
        planName,
        planActivated: activation.matchedCount > 0,
        transactionId,
      });
    } catch (error) {
      console.error("Failed to verify Stripe checkout:", error);
      return res.status(500).json({
        success: false,
        error: "Could not verify this payment. Please try again.",
      });
    }
  }
);


function serializePayment(payment) {
  const rawDate =
    payment.createdAt instanceof Date
      ? payment.createdAt.toISOString()
      : payment.createdAt ??
        (payment.payment_date instanceof Date
          ? payment.payment_date.toISOString()
          : payment.payment_date);
  const date =
    typeof rawDate === "string" && !Number.isNaN(Date.parse(rawDate))
      ? new Date(rawDate).toISOString()
      : new Date(0).toISOString();
  const id =
    payment._id instanceof ObjectId
      ? payment._id.toString()
      : payment._id?.toString() ??
        payment.sessionId ??
        payment.stripeSessionId ??
        "";
  const transactionId =
    payment.transactionId ??
    (typeof payment.payment_intent === "string"
      ? payment.payment_intent
      : payment.payment_intent?.id) ??
    payment.sessionId ??
    "";

  return {
    id,
    date: date instanceof Date ? date.toISOString() : date,
    plan: payment.plan,
    amountCents: payment.amountCents ?? 0,
    transactionId,
  };
}

function serializeSavedJob(savedJob) {
  const { _id, jobId, ...fields } = savedJob;
  const savedAt =
    savedJob.savedAt instanceof Date
      ? savedJob.savedAt.toISOString()
      : savedJob.savedAt;

  return {
    ...fields,
    id: _id.toString(),
    jobId: jobId.toString(),
    savedAt,
  };
}

function serializeRecruiterJob(job, applicantCount = 0) {
  const { _id, recruiterId, ...fields } = job;
  const id = _id.toString();
  return {
    ...fields,
    id,
    _id: id,
    applicants: applicantCount,
  };
}

function serializeRecruiterApplication(application) {
  const { _id, jobId, recruiterId, userId, ...fields } = application;
  return {
    ...fields,
    id: _id.toString(),
    jobId: jobId.toString(),
    appliedAt:
      application.appliedAt instanceof Date
        ? application.appliedAt.toISOString()
        : application.appliedAt,
  };
}

function serializeCompany(company) {
  const fields = { ...company };
  const id = fields._id.toString();
  delete fields._id;
  delete fields.recruiterId;
  return { ...fields, id, _id: id };
}

function getCompanyFields(body) {
  const fields = { ...body };
  delete fields._id;
  delete fields.recruiterId;
  delete fields.status;
  delete fields.createdAt;
  delete fields.updatedAt;
  return fields;
}

async function listRecruiterJobs(recruiterId) {
  const ownedJobs = await jobs
    .find({ recruiterId })
    .sort({ createdAt: -1 })
    .toArray();
  if (ownedJobs.length === 0) return [];

  const jobIds = ownedJobs.map((job) => job._id);
  const applicantCounts = await applications
    .aggregate([
      { $match: { jobId: { $in: jobIds } } },
      { $group: { _id: "$jobId", count: { $sum: 1 } } },
    ])
    .toArray();
  const countByJobId = new Map(
    applicantCounts.map((entry) => [entry._id.toString(), entry.count])
  );

  return ownedJobs.map((job) =>
    serializeRecruiterJob(job, countByJobId.get(job._id.toString()) ?? 0)
  );
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
app.get(
  "/recruiter/job-capacity",
  requireAuthenticatedUser,
  requireRecruiter,
  async (req, res) => {
    try {
      return res.json(await getRecruiterJobCapacity(req.authUser.id));
    } catch (err) {
      if (err?.code === "RECRUITER_ACCOUNT_NOT_FOUND") {
        return res.status(401).json({ error: err.message, code: err.code });
      }
      if (err?.code === "RECRUITER_ACCOUNT_REQUIRED") {
        return res.status(403).json({ error: err.message, code: err.code });
      }
      console.error("Failed to load recruiter job capacity:", err);
      return res.status(500).json({
        error: "Could not check your active job post limit. Please try again.",
      });
    }
  }
);

app.get(
  "/recruiter/billing/payments",
  requireAuthenticatedUser,
  requireRecruiter,
  async (req, res) => {
    try {
      const records = await payments
        .find({ userId: req.authUser.id })
        .sort({ createdAt: -1 })
        .toArray();
      return res.json(records.map(serializePayment));
    } catch (err) {
      console.error("Failed to load recruiter payment history:", err);
      return res.status(500).json({
        error: "Could not load your payment history. Please try again.",
      });
    }
  }
);

app.post("/jobs", requireAuthenticatedUser, requireRecruiter, async (req, res) => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({
      code: "INVALID_JOB",
      error: "Job details are required.",
    });
  }

  const job = { ...req.body };
  delete job._id;
  delete job.userId;
  delete job.recruiterId;
  delete job.createdBy;
  delete job.applicants;
  delete job.status;
  job.recruiterId = req.authUser.id;
  job.createdAt = new Date().toISOString();

  try {
    const capacity = await getRecruiterJobCapacity(req.authUser.id);
    if (capacity.activeJobs >= capacity.limit) {
      return res.status(409).json({
        code: "ACTIVE_JOB_LIMIT_REACHED",
        error: `Your ${capacity.plan} plan allows up to ${capacity.limit} active job posts. Close or remove an active job, or upgrade your plan.`,
        ...capacity,
      });
    }

    const result = await jobs.insertOne(job);
    return res.status(201).json({ ...job, id: result.insertedId.toString() });
  } catch (err) {
    if (err?.code === "RECRUITER_ACCOUNT_NOT_FOUND") {
      return res.status(401).json({ error: err.message, code: err.code });
    }
    if (err?.code === "RECRUITER_ACCOUNT_REQUIRED") {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    console.error("Failed to create recruiter job:", err);
    return res.status(500).json({
      error: "Could not publish the job. Please try again.",
    });
  }
});

app.get(
  "/recruiter/jobs",
  requireAuthenticatedUser,
  requireRecruiter,
  async (req, res) => {
    try {
      return res.json(await listRecruiterJobs(req.authUser.id));
    } catch (err) {
      console.error("Failed to load recruiter jobs:", err);
      return res.status(500).json({
        error: "Could not load your job posts. Please try again.",
      });
    }
  }
);

app.get(
  "/recruiter/jobs/:jobId",
  requireAuthenticatedUser,
  requireRecruiter,
  async (req, res) => {
    if (!ObjectId.isValid(req.params.jobId)) {
      return res.status(400).json({
        code: "INVALID_JOB_ID",
        error: "A valid job ID is required.",
      });
    }

    try {
      const job = await jobs.findOne({
        _id: new ObjectId(req.params.jobId),
        recruiterId: req.authUser.id,
      });
      if (!job) {
        return res.status(404).json({
          code: "JOB_NOT_FOUND",
          error: "Job not found.",
        });
      }

      const applicantCount = await applications.countDocuments({
        jobId: job._id,
      });
      return res.json(serializeRecruiterJob(job, applicantCount));
    } catch (error) {
      console.error("Failed to load recruiter job:", error);
      return res.status(500).json({
        error: "Could not load this job post. Please try again.",
      });
    }
  }
);

app.put(
  "/recruiter/jobs/:jobId",
  requireAuthenticatedUser,
  requireRecruiter,
  async (req, res) => {
    if (!ObjectId.isValid(req.params.jobId)) {
      return res.status(400).json({
        code: "INVALID_JOB_ID",
        error: "A valid job ID is required.",
      });
    }

    const body = req.body;
    const requiredTextFields = [
      "title",
      "company",
      "category",
      "jobType",
      "location",
      "responsibilities",
      "requirements",
    ];
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      requiredTextFields.some(
        (field) => typeof body[field] !== "string" || !body[field].trim()
      ) ||
      typeof body.isRemote !== "boolean" ||
      ["deadline", "minSalary", "maxSalary", "frequency"].some(
        (field) => field in body && typeof body[field] !== "string"
      )
    ) {
      return res.status(400).json({
        code: "INVALID_JOB",
        error: "Complete all required job details before saving.",
      });
    }

    const updates = {
      title: body.title.trim(),
      company: body.company.trim(),
      category: body.category.trim(),
      jobType: body.jobType.trim(),
      isRemote: body.isRemote,
      location: body.location.trim(),
      deadline: body.deadline ?? "",
      minSalary: body.minSalary ?? "",
      maxSalary: body.maxSalary ?? "",
      frequency: body.frequency ?? "per year",
      responsibilities: body.responsibilities.trim(),
      requirements: body.requirements.trim(),
      updatedAt: new Date().toISOString(),
    };

    try {
      const jobId = new ObjectId(req.params.jobId);
      const result = await jobs.updateOne(
        { _id: jobId, recruiterId: req.authUser.id },
        { $set: updates }
      );
      if (!result.matchedCount) {
        return res.status(404).json({
          code: "JOB_NOT_FOUND",
          error: "Job not found.",
        });
      }

      const updatedJob = await jobs.findOne({
        _id: jobId,
        recruiterId: req.authUser.id,
      });
      const applicantCount = await applications.countDocuments({ jobId });
      return res.json(serializeRecruiterJob(updatedJob, applicantCount));
    } catch (error) {
      console.error("Failed to update recruiter job:", error);
      return res.status(500).json({
        error: "Could not update the job post. Please try again.",
      });
    }
  }
);

app.get(
  "/recruiter/dashboard",
  requireAuthenticatedUser,
  requireRecruiter,
  async (req, res) => {
    try {
      const ownedJobs = await listRecruiterJobs(req.authUser.id);
      const jobIds = ownedJobs.map((job) => new ObjectId(job.id));
      const recentApplications = jobIds.length
        ? await applications
            .find({ jobId: { $in: jobIds } })
            .sort({ appliedAt: -1 })
            .limit(5)
            .toArray()
        : [];
      const now = new Date();
      const isExpired = (job) => {
        if (!job.deadline) return false;
        const deadline = new Date(job.deadline);
        return !Number.isNaN(deadline.getTime()) && deadline < now;
      };
      const activeJobs = ownedJobs.filter((job) =>
        job.status ? job.status === "Active" : !isExpired(job)
      ).length;
      const jobsClosed = ownedJobs.filter(
        (job) =>
          job.status === "Closed" ||
          job.status === "Expired" ||
          (!job.status && isExpired(job))
      ).length;

      return res.json({
        stats: {
          totalJobPosts: ownedJobs.length,
          totalApplicants: ownedJobs.reduce(
            (total, job) => total + job.applicants,
            0
          ),
          activeJobs,
          jobsClosed,
        },
        recentApplications: recentApplications.map(
          serializeRecruiterApplication
        ),
      });
    } catch (err) {
      console.error("Failed to load recruiter dashboard:", err);
      return res.status(500).json({
        error: "Could not load your recruiter dashboard. Please try again.",
      });
    }
  }
);

app.get(
  "/recruiter/notifications",
  requireAuthenticatedUser,
  requireRecruiter,
  async (req, res) => {
    try {
      const ownedJobs = await jobs
        .find({ recruiterId: req.authUser.id })
        .project({ _id: 1 })
        .toArray();
      const jobIds = ownedJobs.map((job) => job._id);
      const recentApplications = jobIds.length
        ? await applications
            .find({ jobId: { $in: jobIds } })
            .sort({ appliedAt: -1 })
            .limit(10)
            .toArray()
        : [];
      const company = await companies.findOne(
        { recruiterId: req.authUser.id },
        { projection: { status: 1, reviewedAt: 1 } }
      );
      const reviewedAt =
        company?.reviewedAt instanceof Date
          ? company.reviewedAt.toISOString()
          : company?.reviewedAt;
      const companyReview =
        (company?.status === "Approved" || company?.status === "Rejected") &&
        typeof reviewedAt === "string"
          ? {
              id: company._id.toString(),
              status: company.status,
              reviewedAt,
            }
          : null;

      return res.json({
        applications: recentApplications.map(serializeRecruiterApplication),
        companyReview,
      });
    } catch (err) {
      console.error("Failed to load recruiter notifications:", err);
      return res.status(500).json({
        error: "Could not load your notifications. Please try again.",
      });
    }
  }
);

app.get(
  "/recruiter/jobs/:jobId/applications",
  requireAuthenticatedUser,
  requireRecruiter,
  async (req, res) => {
    if (!ObjectId.isValid(req.params.jobId)) {
      return res.status(400).json({
        code: "INVALID_JOB_ID",
        error: "A valid job ID is required.",
      });
    }

    try {
      const jobId = new ObjectId(req.params.jobId);
      const job = await jobs.findOne({
        _id: jobId,
        recruiterId: req.authUser.id,
      });
      if (!job) {
        return res.status(404).json({
          code: "JOB_NOT_FOUND",
          error: "Job not found.",
        });
      }

      const jobApplications = await applications
        .find({ jobId })
        .sort({ appliedAt: -1 })
        .toArray();
      return res.json({
        job: {
          id: jobId.toString(),
          title: job.title ?? "Untitled job",
          company: job.company ?? "Company",
        },
        applications: jobApplications.map(serializeRecruiterApplication),
      });
    } catch (err) {
      console.error("Failed to load recruiter job applications:", err);
      return res.status(500).json({
        error: "Could not load applicants for this job. Please try again.",
      });
    }
  }
);

app.patch(
  "/recruiter/jobs/:jobId/applications/:applicationId/status",
  requireAuthenticatedUser,
  requireRecruiter,
  async (req, res) => {
    const { jobId: jobIdParam, applicationId: applicationIdParam } = req.params;
    const validStatuses = [
      "Applied",
      "Under Review",
      "Shortlisted",
      "Rejected",
      "Offered",
    ];
    if (
      !ObjectId.isValid(jobIdParam) ||
      !ObjectId.isValid(applicationIdParam) ||
      !validStatuses.includes(req.body?.status)
    ) {
      return res.status(400).json({
        code: "INVALID_APPLICATION_STATUS",
        error: "A valid job, application, and status are required.",
      });
    }

    try {
      const jobId = new ObjectId(jobIdParam);
      const applicationId = new ObjectId(applicationIdParam);
      const job = await jobs.findOne({
        _id: jobId,
        recruiterId: req.authUser.id,
      });
      if (!job) {
        return res.status(404).json({
          code: "JOB_NOT_FOUND",
          error: "Job not found.",
        });
      }

      const result = await applications.updateOne(
        { _id: applicationId, jobId },
        { $set: { status: req.body.status, updatedAt: new Date() } }
      );
      if (!result.matchedCount) {
        return res.status(404).json({
          code: "APPLICATION_NOT_FOUND",
          error: "Application not found for this job.",
        });
      }

      return res.json({ updated: true, status: req.body.status });
    } catch (err) {
      console.error("Failed to update recruiter application status:", err);
      return res.status(500).json({
        error: "Could not update the application status. Please try again.",
      });
    }
  }
);

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
    const cursor = jobs.find(filter).project({ recruiterId: 0 });
    const result = await cursor.toArray();
    res.send(result);
  } catch (err) {
    res.status(500).send({ error: "Failed to load jobs" });
  }
});

app.get("/jobs/:id", async (req, res) => {
  try {
    const job = await jobs.findOne(
      { _id: new ObjectId(req.params.id) },
      { projection: { recruiterId: 0 } }
    );
    if (!job) return res.status(404).send({ error: "Job not found" });
    res.send(job);
  } catch (err) {
    res.status(400).send({ error: "Invalid job id" });
  }
});

// Seeker applications
app.get("/billing/payments", requireAuthenticatedUser, async (req, res) => {
  if (req.authUser.role && req.authUser.role !== "seeker") {
    return res.status(403).json({
      code: "SEEKER_ACCOUNT_REQUIRED",
      error: "Only seeker accounts can view payment history.",
    });
  }

  try {
    const records = await payments
      .find({ userId: req.authUser.id })
      .sort({ createdAt: -1 })
      .toArray();
    return res.json(records.map(serializePayment));
  } catch (err) {
    console.error("Failed to load seeker payment history:", err);
    return res.status(500).json({
      error: "Could not load your payment history. Please try again.",
    });
  }
});

app.get("/applications/usage", requireAuthenticatedUser, async (req, res) => {
  if (req.authUser.role && req.authUser.role !== "seeker") {
    return res.status(403).json({
      code: "SEEKER_ACCOUNT_REQUIRED",
      error: "Only seeker accounts can view application usage.",
    });
  }

  try {
    const accountId = ObjectId.isValid(req.authUser.id)
      ? new ObjectId(req.authUser.id)
      : req.authUser.id;
    const account = await users.findOne(
      { _id: accountId },
      { projection: { role: 1, plan: 1 } }
    );
    if (!account) {
      return res.status(401).json({ error: "Your account could not be found." });
    }
    if (account.role && account.role !== "seeker") {
      return res.status(403).json({
        code: "SEEKER_ACCOUNT_REQUIRED",
        error: "Only seeker accounts can view application usage.",
      });
    }

    const plan = getApplicationPlan(account.plan, req.authUser.plan);
    const period = getApplicationPeriod();
    const usage = await applicationUsage.findOne({
      userId: req.authUser.id,
      period,
    });
    const limit = getApplicationLimit(plan);
    const used = usage?.count ?? 0;

    return res.json({
      plan,
      used,
      limit,
      remaining: limit === null ? null : Math.max(limit - used, 0),
      period,
    });
  } catch (err) {
    console.error("Failed to load seeker application usage:", err);
    return res.status(500).json({
      error: "Could not check your application usage. Please try again.",
    });
  }
});

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
    const accountId = ObjectId.isValid(userId) ? new ObjectId(userId) : userId;
    const account = await users.findOne(
      { _id: accountId },
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

    const plan = getApplicationPlan(account.plan, req.authUser.plan);
    const now = new Date();
    const period = getApplicationPeriod(now);
    const usage = await reserveApplicationUsage(userId, period, plan);

    if (!usage.allowed) {
      const planName = plan === "growth" ? "Pro" : "Free";
      return res.status(429).json({
        code: "APPLICATION_LIMIT_REACHED",
        error: `The ${planName} plan allows up to ${usage.limit} applications per month.`,
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

app.get("/saved-jobs/me", requireAuthenticatedUser, async (req, res) => {
  if (req.authUser.role && req.authUser.role !== "seeker") {
    return res.status(403).json({
      code: "SEEKER_ACCOUNT_REQUIRED",
      error: "Only seeker accounts can view saved jobs.",
    });
  }

  try {
    const result = await savedJobs
      .find({ userId: req.authUser.id })
      .sort({ savedAt: -1 })
      .toArray();
    return res.json(result.map(serializeSavedJob));
  } catch (err) {
    console.error("Failed to load saved jobs:", err);
    return res.status(500).json({
      error: "Could not load your saved jobs. Please try again.",
    });
  }
});

app.post("/saved-jobs", requireAuthenticatedUser, async (req, res) => {
  const userId = req.authUser.id;
  const { jobId } = req.body ?? {};

  if (req.authUser.role && req.authUser.role !== "seeker") {
    return res.status(403).json({
      code: "SEEKER_ACCOUNT_REQUIRED",
      error: "Only seeker accounts can save jobs.",
    });
  }
  if (typeof jobId !== "string" || !ObjectId.isValid(jobId)) {
    return res.status(400).json({
      code: "INVALID_JOB_ID",
      error: "A valid job ID is required.",
    });
  }

  try {
    const jobObjectId = new ObjectId(jobId);
    const job = await jobs.findOne({ _id: jobObjectId });
    if (!job) {
      return res.status(404).json({
        code: "JOB_NOT_FOUND",
        error: "This job is no longer available.",
      });
    }

    const existing = await savedJobs.findOne({ userId, jobId: jobObjectId });
    if (existing) {
      return res.status(200).json({
        savedJob: serializeSavedJob(existing),
        alreadySaved: true,
      });
    }

    const savedJob = {
      userId,
      jobId: jobObjectId,
      jobTitle: job.title ?? "Untitled job",
      company: job.company ?? "Company",
      location: job.location ?? "",
      minSalary: job.minSalary ?? null,
      maxSalary: job.maxSalary ?? null,
      frequency: job.frequency ?? "",
      savedAt: new Date(),
    };

    try {
      const result = await savedJobs.insertOne(savedJob);
      return res.status(201).json({
        savedJob: serializeSavedJob({
          ...savedJob,
          _id: result.insertedId,
        }),
        alreadySaved: false,
      });
    } catch (err) {
      if (err?.code !== 11000) throw err;

      const duplicate = await savedJobs.findOne({ userId, jobId: jobObjectId });
      if (!duplicate) throw err;

      return res.status(200).json({
        savedJob: serializeSavedJob(duplicate),
        alreadySaved: true,
      });
    }
  } catch (err) {
    console.error("Failed to save job:", err);
    return res.status(500).json({
      code: "SAVED_JOB_SAVE_FAILED",
      error: "Could not save this job. Please try again.",
    });
  }
});

app.delete(
  "/saved-jobs/:jobId",
  requireAuthenticatedUser,
  async (req, res) => {
    if (req.authUser.role && req.authUser.role !== "seeker") {
      return res.status(403).json({
        code: "SEEKER_ACCOUNT_REQUIRED",
        error: "Only seeker accounts can remove saved jobs.",
      });
    }
    if (!ObjectId.isValid(req.params.jobId)) {
      return res.status(400).json({
        code: "INVALID_JOB_ID",
        error: "A valid job ID is required.",
      });
    }

    try {
      const result = await savedJobs.deleteOne({
        userId: req.authUser.id,
        jobId: new ObjectId(req.params.jobId),
      });
      return res.json({ removed: result.deletedCount > 0 });
    } catch (err) {
      console.error("Failed to remove saved job:", err);
      return res.status(500).json({
        error: "Could not remove this saved job. Please try again.",
      });
    }
  }
);

app.post("/profile/email", requireAuthenticatedUser, async (req, res) => {
  if (req.authUser.role && req.authUser.role !== "seeker") {
    return res.status(403).json({
      code: "SEEKER_ACCOUNT_REQUIRED",
      error: "Only seeker accounts can update this profile.",
    });
  }

  if (typeof req.body?.email !== "string") {
    return res.status(400).json({
      code: "INVALID_EMAIL",
      error: "Enter a valid email address.",
    });
  }

  const email = req.body.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      code: "INVALID_EMAIL",
      error: "Enter a valid email address.",
    });
  }

  const userId = String(req.authUser.id);
  if (email === String(req.authUser.email ?? "").toLowerCase()) {
    return res.json({
      email,
      emailVerified: req.authUser.emailVerified === true,
      unchanged: true,
    });
  }

  try {
    const accountId = ObjectId.isValid(userId) ? new ObjectId(userId) : userId;
    const existing = await users.findOne(
      { email },
      { projection: { _id: 1 } }
    );
    if (existing && existing._id.toString() !== userId) {
      return res.status(409).json({
        code: "EMAIL_ALREADY_IN_USE",
        error: "That email address is already associated with an account.",
      });
    }

    const result = await users.updateOne(
      { _id: accountId },
      { $set: { email, emailVerified: false, updatedAt: new Date() } }
    );
    if (!result.matchedCount) {
      return res.status(404).json({
        error: "Your account could not be found.",
      });
    }

    return res.json({ email, emailVerified: false, unchanged: false });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({
        code: "EMAIL_ALREADY_IN_USE",
        error: "That email address is already associated with an account.",
      });
    }
    console.error("Failed to update seeker email:", err);
    return res.status(500).json({
      error: "Could not update your email. Please try again.",
    });
  }
});

app.get("/profile/resume/info", requireAuthenticatedUser, async (req, res) => {
  if (req.authUser.role && req.authUser.role !== "seeker") {
    return res.status(403).json({
      code: "SEEKER_ACCOUNT_REQUIRED",
      error: "Only seeker accounts can view this profile.",
    });
  }

  try {
    const resume = await resumes.findOne(
      { userId: req.authUser.id },
      { projection: { fileName: 1, size: 1, updatedAt: 1 } }
    );
    return res.json({
      resume: resume
        ? {
            fileName: resume.fileName,
            size: resume.size,
            updatedAt:
              resume.updatedAt instanceof Date
                ? resume.updatedAt.toISOString()
                : resume.updatedAt,
          }
        : null,
    });
  } catch (err) {
    console.error("Failed to load seeker resume metadata:", err);
    return res.status(500).json({
      error: "Could not load your resume details. Please try again.",
    });
  }
});

app.get("/profile/resume", requireAuthenticatedUser, async (req, res) => {
  if (req.authUser.role && req.authUser.role !== "seeker") {
    return res.status(403).json({
      code: "SEEKER_ACCOUNT_REQUIRED",
      error: "Only seeker accounts can download this resume.",
    });
  }

  try {
    const resume = await resumes.findOne({ userId: req.authUser.id });
    if (!resume) {
      return res.status(404).json({
        code: "RESUME_NOT_FOUND",
        error: "No resume has been uploaded yet.",
      });
    }

    const pdf = Buffer.isBuffer(resume.data)
      ? resume.data
      : resume.data?.value?.(true);
    if (!Buffer.isBuffer(pdf)) {
      throw new Error("Stored resume data is not a buffer.");
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", pdf.length);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(resume.fileName)}`
    );
    return res.send(pdf);
  } catch (err) {
    console.error("Failed to download seeker resume:", err);
    return res.status(500).json({
      error: "Could not download your resume. Please try again.",
    });
  }
});

app.put(
  "/profile/resume",
  requireAuthenticatedUser,
  parseResumePdf,
  async (req, res) => {
    if (req.authUser.role && req.authUser.role !== "seeker") {
      return res.status(403).json({
        code: "SEEKER_ACCOUNT_REQUIRED",
        error: "Only seeker accounts can upload a resume.",
      });
    }
    if (!req.is("application/pdf") || !Buffer.isBuffer(req.body)) {
      return res.status(415).json({
        code: "PDF_REQUIRED",
        error: "Upload a PDF resume.",
      });
    }
    if (
      req.body.length < 5 ||
      req.body.subarray(0, 5).toString("ascii") !== "%PDF-"
    ) {
      return res.status(400).json({
        code: "INVALID_PDF",
        error: "The uploaded file is not a valid PDF.",
      });
    }

    let fileName = req.get("x-file-name") || "resume.pdf";
    try {
      fileName = decodeURIComponent(fileName);
    } catch {
      return res.status(400).json({
        code: "INVALID_FILE_NAME",
        error: "The resume file name is invalid.",
      });
    }
    fileName = fileName.replace(/[\\/"\r\n]/g, "_").slice(0, 180);
    if (!fileName.toLowerCase().endsWith(".pdf")) {
      return res.status(400).json({
        code: "PDF_REQUIRED",
        error: "Upload a PDF resume.",
      });
    }

    try {
      const now = new Date();
      await resumes.updateOne(
        { userId: req.authUser.id },
        {
          $set: {
            fileName,
            contentType: "application/pdf",
            size: req.body.length,
            data: req.body,
            updatedAt: now,
          },
          $setOnInsert: { userId: req.authUser.id, createdAt: now },
        },
        { upsert: true }
      );
      return res.status(200).json({
        fileName,
        size: req.body.length,
        updatedAt: now.toISOString(),
      });
    } catch (err) {
      console.error("Failed to save seeker resume:", err);
      return res.status(500).json({
        error: "Could not save your resume. Please try again.",
      });
    }
  }
);

//  app.delete('/jobs/:id', async(req, res) =>{
//   const id = req.params.id;
//   const query = {_id: new ObjectId(id)};
//   const result = await jobs. deleteOne(query);
//   res.send(result);
//    })

app.delete(
  "/jobs/:id",
  requireAuthenticatedUser,
  requireRecruiter,
  async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        code: "INVALID_JOB_ID",
        error: "A valid job ID is required.",
      });
    }

   try {
      const result = await jobs.deleteOne({
        _id: new ObjectId(req.params.id),
        recruiterId: req.authUser.id,
      });
      if (!result.deletedCount) {
        return res.status(404).json({
          code: "JOB_NOT_FOUND",
          error: "Job not found.",
        });
      }
      return res.json({ deleted: true });
  } catch (err) {
      console.error("Failed to delete recruiter job:", err);
      return res.status(500).json({
        error: "Could not delete the job. Please try again.",
      });
   }
  }
);

// Companies related APIs
app.get(
  "/recruiter/company",
  requireAuthenticatedUser,
  requireRecruiter,
  async (req, res) => {
    try {
      const company = await companies.findOne({ recruiterId: req.authUser.id });
      return res.json({ company: company ? serializeCompany(company) : null });
    } catch (err) {
      console.error("Failed to load recruiter company:", err);
      return res.status(500).json({ error: "Failed to load company details." });
    }
  }
);

app.get('/companies', async (req, res) => {
  try {
    const cursor = companies.find({});
    const result = await cursor.toArray();
    res.send(result.map(serializeCompany));
  } catch (err) {
    res.status(500).send({ error: 'Failed to load companies' });
  }
});

app.get('/companies/:id', async (req, res) => {
  try {
    const company = await companies.findOne({ _id: new ObjectId(req.params.id) });
    if (!company) return res.status(404).send({ error: 'Company not found' });
    res.send(serializeCompany(company));
  } catch (err) {
    res.status(400).send({ error: 'Invalid company id' });
  }
});

app.post(
  "/companies",
  requireAuthenticatedUser,
  requireRecruiter,
  async (req, res) => {
    try {
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        return res.status(400).json({ error: "Company details are required." });
      }
      const fields = getCompanyFields(req.body);
      const company = {
        ...fields,
        recruiterId: req.authUser.id,
        status: "Pending",
        createdAt: new Date().toISOString(),
      };
      const result = await companies.insertOne(company);
      const savedCompany = { ...company, _id: result.insertedId };
      return res.status(201).json(serializeCompany(savedCompany));
    } catch (err) {
      if (err?.code === 11000) {
        return res.status(409).json({
          code: "COMPANY_ALREADY_REGISTERED",
          error: "You have already registered a company.",
        });
      }
      console.error("Failed to create company:", err);
      return res.status(500).send({ error: 'Failed to create company' });
    }
  }
);

app.put(
  "/companies/:id",
  requireAuthenticatedUser,
  requireRecruiter,
  async (req, res) => {
    let companyId;
    try {
      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ error: "Invalid company id." });
      }
      companyId = new ObjectId(req.params.id);
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        return res.status(400).json({ error: "Company details are required." });
      }
      const updates = getCompanyFields(req.body);
      const result = await companies.updateOne(
        { _id: companyId, recruiterId: req.authUser.id },
        { $set: { ...updates, status: "Pending", updatedAt: new Date().toISOString() } }
      );
      if (!result.matchedCount) {
        return res.status(404).json({
          code: "COMPANY_NOT_FOUND",
          error: "Company not found.",
        });
      }
      const company = await companies.findOne({
        _id: companyId,
        recruiterId: req.authUser.id,
      });
      return res.json(serializeCompany(company));
    } catch (err) {
      console.error("Failed to update recruiter company:", err);
      return res.status(500).json({ error: "Failed to update company." });
    }
  }
);

// Admin: update company status
app.patch(
  "/companies/:id/status",
  requireAuthenticatedUser,
  requireAdmin,
  async (req, res) => {
    try {
      const { status } = req.body ?? {};
      if (!["Pending", "Approved", "Rejected"].includes(status)) {
        return res.status(400).json({
          code: "INVALID_COMPANY_STATUS",
          error: "Status must be Pending, Approved, or Rejected.",
        });
      }
      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ error: "Invalid company id." });
      }
      const _id = new ObjectId(req.params.id);
      const result = await companies.updateOne(
        { _id },
        { $set: { status, reviewedAt: new Date().toISOString() } }
      );
      if (!result.matchedCount) {
        return res.status(404).json({ error: "Company not found." });
      }
      const company = await companies.findOne({ _id });
      return res.json(serializeCompany(company));
    } catch (err) {
      console.error("Failed to update company status:", err);
      return res.status(500).json({ error: "Failed to update company status." });
    }
  }
);

app.listen(port, () => {
  console.log(`hireloop is running on port ${port}`);
});