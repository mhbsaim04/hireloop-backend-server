import express from 'express';
import cors from 'cors';
import 'dotenv/config'
import { MongoClient, ObjectId } from 'mongodb';


const app = express();
const port = process.env.PORT || 7000;

// middleware
app.use(express.json());
app.use(cors());

const client = new MongoClient(process.env.MONGODB_URI);
export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db('hireloop-db')
const users = database.collection("user")
const jobs = database.collection("jobs")
const companies = database.collection("companies")


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