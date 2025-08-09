import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const REALTOR_API_KEY = process.env.REALTOR_API_KEY || process.env.REALTOR_RAPIDAPI_KEY || '';

// Simple in-memory stores
const users = []; // {id,email,passwordHash}
const workflows = {}; // userId -> {steps:[], documents:[]}

// create uploads dir
const uploadsDir = path.join(process.cwd(), 'uploads');
if(!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g,'_'))
});
const upload = multer({ storage });

// helper: proxy to Realtor to get latest properties (12)
let listingsCache = { ts:0, data:null };
async function fetchLatestListings(limit=12){
  // cache for 10 minutes
  const now = Date.now();
  if(listingsCache.data && (now - listingsCache.ts) < 10*60*1000){
    return listingsCache.data;
  }
  try{
    const url = `https://realtor.p.rapidapi.com/properties/v2/list-for-sale?limit=${limit}&offset=0&sort=recently_listed`;
    const res = await fetch(url, { headers:{ 'X-RapidAPI-Key': REALTOR_API_KEY, 'X-RapidAPI-Host':'realtor.p.rapidapi.com' } });
    const body = await res.json();
    const results = body?.properties || body?.data?.home_search?.results || [];
    listingsCache = { ts: now, data: results };
    return results;
  }catch(err){
    console.error('Realtor fetch error', err.message);
    return [];
  }
}

// public listings; accepts optional lat/lon or postal_code
app.get('/listings', async (req,res)=>{
  const { lat, lon, postal_code } = req.query;
  try{
    if(lat && lon){
      const url = `https://realtor.p.rapidapi.com/properties/v2/nearby?lat=${lat}&lon=${lon}&limit=12`;
      const r = await fetch(url, { headers:{ 'X-RapidAPI-Key': REALTOR_API_KEY, 'X-RapidAPI-Host':'realtor.p.rapidapi.com' } });
      const d = await r.json();
      return res.json({ results: d?.properties || [] });
    }
    if(postal_code){
      const url = `https://realtor.p.rapidapi.com/properties/v2/list-for-sale?postal_code=${encodeURIComponent(postal_code)}&limit=12&offset=0&sort=relevance`;
      const r = await fetch(url, { headers:{ 'X-RapidAPI-Key': REALTOR_API_KEY, 'X-RapidAPI-Host':'realtor.p.rapidapi.com' } });
      const d = await r.json();
      return res.json({ results: d?.properties || [] });
    }
    const results = await fetchLatestListings(12);
    return res.json({ results });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: 'failed' });
  }
});

// simple auth (register/login) - in-memory, no hashing for speed (not for production)
app.post('/auth/register', (req,res)=>{
  const { email, password } = req.body;
  if(!email || !password) return res.status(400).json({ error:'missing' });
  const exists = users.find(u=>u.email===email);
  if(exists) return res.status(400).json({ error:'exists' });
  const id = String(Date.now()) + Math.floor(Math.random()*1000);
  users.push({ id, email, password });
  workflows[id] = { steps:[], documents:[] };
  res.json({ ok:true, user:{id,email} });
});

app.post('/auth/login', (req,res)=>{
  const { email, password } = req.body;
  const u = users.find(x=>x.email===email && x.password===password);
  if(!u) return res.status(401).json({ error:'invalid' });
  // return simple token = user id (insecure placeholder)
  res.json({ token: u.id, user:{ id: u.id, email: u.email } });
});

// Middleware to check token header 'authorization: Bearer <id>'
function auth(req,res,next){
  const h = req.headers.authorization;
  if(!h) return res.status(401).json({ error:'no auth' });
  const parts = h.split(' ');
  if(parts.length!==2) return res.status(401).json({ error:'malformed' });
  const token = parts[1];
  const user = users.find(u=>u.id===token);
  if(!user) return res.status(401).json({ error:'invalid token' });
  req.user = user;
  next();
}

// workflow endpoints
app.get('/workflows', auth, (req,res)=>{
  const id = req.user.id;
  res.json({ workflow: workflows[id] || { steps:[], documents:[] } });
});

app.post('/workflows/select', auth, (req,res)=>{
  const id = req.user.id;
  const { property } = req.body;
  workflows[id] = workflows[id] || { steps:[], documents:[] };
  workflows[id].selectedProperty = property;
  res.json({ ok:true, workflow: workflows[id] });
});

// upload for workflow step
app.post('/workflows/:step/upload', auth, upload.single('file'), (req,res)=>{
  if(!req.file) return res.status(400).json({ error:'no file' });
  const id = req.user.id;
  workflows[id] = workflows[id] || { steps:[], documents:[] };
  const url = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  workflows[id].documents.push({ name:req.file.originalname, url, step:req.params.step, uploadedAt: new Date().toISOString() });
  res.json({ ok:true, url });
});

app.get('/documents', auth, (req,res)=>{
  const id = req.user.id;
  res.json({ documents: (workflows[id] && workflows[id].documents) || [] });
});

// static uploads
app.use('/uploads', express.static(uploadsDir));

app.listen(PORT, ()=>{
  console.log('Closied backend running on', PORT);
});
