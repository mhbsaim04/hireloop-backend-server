import express from 'express';
import cors from 'cors';
import 'dotenv/config'
import { MongoClient } from 'mongodb';


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


app.get('/', (req, res) => {
  res.send('hireloop is connected!!');
});

app.listen(port, () => {
  console.log(`hireloop is running on port ${port}`);
});