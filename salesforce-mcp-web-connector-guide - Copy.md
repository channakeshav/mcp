# Building a Web-Based Salesforce MCP Connector for Claude.ai

This guide shows you how to build an MCP server that runs as a web service, allowing Claude on the web (claude.ai) to connect to Salesforce through a publicly accessible endpoint.

## Architecture Overview

```
Claude.ai Web ←→ MCP Web Server (HTTPS) ←→ Salesforce API
                      ↓
                 OAuth Portal
                      ↓
                User Authentication
```

**Key Differences from Desktop:**
- Server runs as a web service with HTTPS endpoint
- Uses Server-Sent Events (SSE) for real-time communication
- Requires OAuth authentication flow
- Users authenticate through web browser
- Publicly accessible (requires hosting)

## Prerequisites

- Node.js 18+ installed
- Salesforce Developer Account
- Domain name or public URL (ngrok for testing)
- Basic knowledge of TypeScript/Express
- SSL certificate (Let's Encrypt for production)

---

## Part 1: Salesforce Connected App Setup

### Step 1.1: Create Connected App

1. Log into Salesforce
2. Go to **Setup** → **Apps** → **App Manager**
3. Click **New Connected App**
4. Fill in:
   - **Connected App Name**: Claude Web MCP Connector
   - **API Name**: claude_web_mcp_connector
   - **Contact Email**: your email
   - **Description**: MCP connector for Claude.ai web interface

5. **Enable OAuth Settings**:
   - ✅ Check "Enable OAuth Settings"
   - **Callback URL**: `https://your-domain.com/oauth/callback`
     - For testing with ngrok: `https://your-ngrok-url.ngrok.io/oauth/callback`
   - **Selected OAuth Scopes**:
     - Full access (full)
     - Perform requests on your behalf at any time (refresh_token, offline_access)
     - Manage user data via APIs (api)
   - ✅ Check "Require Secret for Web Server Flow"
   - ✅ Check "Require Secret for Refresh Token Flow"

6. Click **Save** and wait 2-10 minutes

7. Click **Manage Consumer Details** to get:
   - **Consumer Key** (Client ID)
   - **Consumer Secret** (Client Secret)

### Step 1.2: Configure Security Settings

1. In Connected App settings, click **Edit Policies**
2. **OAuth Policies**:
   - Permitted Users: **All users may self-authorize**
   - IP Relaxation: **Relax IP restrictions**
   - Refresh Token Policy: **Refresh token is valid until revoked**

3. **Save**

---

## Part 2: Project Setup

### Step 2.1: Initialize Project

```bash
# Create project
mkdir salesforce-mcp-web-server
cd salesforce-mcp-web-server

# Initialize npm
npm init -y

# Install dependencies
npm install express
npm install @modelcontextprotocol/sdk
npm install jsforce
npm install dotenv
npm install cors
npm install express-session
npm install cookie-parser

# Install dev dependencies
npm install -D @types/node @types/express @types/cors @types/express-session typescript ts-node nodemon
npm install -D @types/cookie-parser

# Initialize TypeScript
npx tsc --init
```

### Step 2.2: Project Structure

```
salesforce-mcp-web-server/
├── src/
│   ├── index.ts           # Main server file
│   ├── mcp-handler.ts     # MCP protocol handler
│   ├── salesforce.ts      # Salesforce integration
│   └── auth.ts            # OAuth authentication
├── public/
│   └── auth-success.html  # OAuth success page
├── .env                   # Environment variables
├── .gitignore
├── package.json
└── tsconfig.json
```

---

## Part 3: Environment Configuration

Create `.env`:

```env
# Server Configuration
PORT=3000
NODE_ENV=development
BASE_URL=https://your-domain.com
# For local testing with ngrok: https://your-ngrok-url.ngrok.io

# Salesforce OAuth
SF_CLIENT_ID=your-consumer-key-from-salesforce
SF_CLIENT_SECRET=your-consumer-secret-from-salesforce
SF_CALLBACK_URL=https://your-domain.com/oauth/callback
SF_LOGIN_URL=https://login.salesforce.com

# Session Secret (generate a random string)
SESSION_SECRET=your-very-secret-random-string-here

# For Salesforce Sandbox (optional)
# SF_LOGIN_URL=https://test.salesforce.com
```

Create `.env.example` (for version control):

```env
PORT=3000
NODE_ENV=development
BASE_URL=https://your-domain.com
SF_CLIENT_ID=your-salesforce-consumer-key
SF_CLIENT_SECRET=your-salesforce-consumer-secret
SF_CALLBACK_URL=https://your-domain.com/oauth/callback
SF_LOGIN_URL=https://login.salesforce.com
SESSION_SECRET=generate-a-random-secret
```

---

## Part 4: Build the MCP Web Server

### Step 4.1: Salesforce Integration (`src/salesforce.ts`)

```typescript
import jsforce from "jsforce";

export interface SalesforceConnection {
  conn: jsforce.Connection;
  userInfo: any;
}

export class SalesforceClient {
  private connections: Map<string, SalesforceConnection> = new Map();

  // Create OAuth2 client
  getOAuth2Client() {
    return new jsforce.OAuth2({
      clientId: process.env.SF_CLIENT_ID!,
      clientSecret: process.env.SF_CLIENT_SECRET!,
      redirectUri: process.env.SF_CALLBACK_URL!,
      loginUrl: process.env.SF_LOGIN_URL || "https://login.salesforce.com",
    });
  }

  // Get authorization URL
  getAuthorizationUrl(): string {
    const oauth2 = this.getOAuth2Client();
    return oauth2.getAuthorizationUrl({
      scope: "api refresh_token full",
    });
  }

  // Handle OAuth callback
  async handleCallback(code: string, userId: string): Promise<void> {
    const oauth2 = this.getOAuth2Client();
    const conn = new jsforce.Connection({ oauth2 });

    // Authorize with code
    await conn.authorize(code);

    // Get user info
    const userInfo = await conn.identity();

    // Store connection
    this.connections.set(userId, { conn, userInfo });

    console.log(`User ${userId} connected to Salesforce:`, userInfo.username);
  }

  // Get connection for user
  getConnection(userId: string): jsforce.Connection | null {
    const connection = this.connections.get(userId);
    return connection ? connection.conn : null;
  }

  // Check if user is authenticated
  isAuthenticated(userId: string): boolean {
    return this.connections.has(userId);
  }

  // Create a lead
  async createLead(userId: string, leadData: any) {
    const conn = this.getConnection(userId);
    if (!conn) {
      throw new Error("User not authenticated with Salesforce");
    }

    const result = await conn.sobject("Lead").create(leadData);

    if (!result.success) {
      throw new Error(`Failed to create lead: ${JSON.stringify(result.errors)}`);
    }

    return result;
  }

  // Search leads
  async searchLeads(userId: string, searchTerm: string, limit: number = 10) {
    const conn = this.getConnection(userId);
    if (!conn) {
      throw new Error("User not authenticated with Salesforce");
    }

    const query = `
      SELECT Id, FirstName, LastName, Company, Email, Phone, Status, CreatedDate
      FROM Lead
      WHERE LastName LIKE '%${searchTerm}%'
         OR Company LIKE '%${searchTerm}%'
         OR Email LIKE '%${searchTerm}%'
      ORDER BY CreatedDate DESC
      LIMIT ${limit}
    `;

    const result = await conn.query(query);
    return result.records;
  }

  // Disconnect user
  disconnect(userId: string): void {
    this.connections.delete(userId);
  }
}
```

### Step 4.2: MCP Handler (`src/mcp-handler.ts`)

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { SalesforceClient } from "./salesforce.js";

export class MCPHandler {
  private server: Server;
  private salesforceClient: SalesforceClient;

  constructor(salesforceClient: SalesforceClient) {
    this.salesforceClient = salesforceClient;

    this.server = new Server(
      {
        name: "salesforce-web-mcp",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = [
        {
          name: "create_lead",
          description:
            "Create a new lead in Salesforce. Required: LastName and Company. Optional: FirstName, Email, Phone, Title, Status, LeadSource, Industry, Description.",
          inputSchema: {
            type: "object",
            properties: {
              FirstName: { type: "string", description: "First name" },
              LastName: { type: "string", description: "Last name (required)" },
              Company: { type: "string", description: "Company name (required)" },
              Email: { type: "string", description: "Email address" },
              Phone: { type: "string", description: "Phone number" },
              Title: { type: "string", description: "Job title" },
              Status: {
                type: "string",
                description: "Lead status",
                default: "Open",
              },
              LeadSource: { type: "string", description: "Lead source" },
              Industry: { type: "string", description: "Industry" },
              Description: { type: "string", description: "Additional notes" },
            },
            required: ["LastName", "Company"],
          },
        },
        {
          name: "search_leads",
          description: "Search for leads in Salesforce by name, email, or company",
          inputSchema: {
            type: "object",
            properties: {
              searchTerm: {
                type: "string",
                description: "Search term to find leads",
              },
              limit: {
                type: "number",
                description: "Maximum number of results (default: 10)",
                default: 10,
              },
            },
            required: ["searchTerm"],
          },
        },
      ];

      return { tools };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;
      
      // Get userId from metadata (passed by the transport layer)
      const userId = (extra as any).userId;

      if (!userId) {
        return {
          content: [
            {
              type: "text",
              text: "Error: User not identified. Please authenticate first.",
            },
          ],
          isError: true,
        };
      }

      try {
        switch (name) {
          case "create_lead":
            return await this.handleCreateLead(userId, args);

          case "search_leads":
            return await this.handleSearchLeads(userId, args);

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    });
  }

  private async handleCreateLead(userId: string, args: any) {
    if (!this.salesforceClient.isAuthenticated(userId)) {
      return {
        content: [
          {
            type: "text",
            text: "Please authenticate with Salesforce first. Visit /auth to connect.",
          },
        ],
        isError: true,
      };
    }

    const leadData: any = {
      LastName: args.LastName,
      Company: args.Company,
      Status: args.Status || "Open",
    };

    // Add optional fields
    if (args.FirstName) leadData.FirstName = args.FirstName;
    if (args.Email) leadData.Email = args.Email;
    if (args.Phone) leadData.Phone = args.Phone;
    if (args.Title) leadData.Title = args.Title;
    if (args.LeadSource) leadData.LeadSource = args.LeadSource;
    if (args.Industry) leadData.Industry = args.Industry;
    if (args.Description) leadData.Description = args.Description;

    const result = await this.salesforceClient.createLead(userId, leadData);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              leadId: result.id,
              message: `Lead created successfully for ${args.FirstName || ""} ${
                args.LastName
              } at ${args.Company}`,
              details: leadData,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleSearchLeads(userId: string, args: any) {
    if (!this.salesforceClient.isAuthenticated(userId)) {
      return {
        content: [
          {
            type: "text",
            text: "Please authenticate with Salesforce first. Visit /auth to connect.",
          },
        ],
        isError: true,
      };
    }

    const leads = await this.salesforceClient.searchLeads(
      userId,
      args.searchTerm,
      args.limit || 10
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              count: leads.length,
              leads: leads,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  getServer(): Server {
    return this.server;
  }
}
```

### Step 4.3: Main Server (`src/index.ts`)

```typescript
import express, { Request, Response } from "express";
import session from "express-session";
import cors from "cors";
import dotenv from "dotenv";
import { SalesforceClient } from "./salesforce.js";
import { MCPHandler } from "./mcp-handler.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Salesforce client and MCP handler
const salesforceClient = new SalesforceClient();
const mcpHandler = new MCPHandler(salesforceClient);

// Middleware
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "your-secret-key",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  })
);

// Serve static files
app.use(express.static(path.join(__dirname, "../public")));

// Health check
app.get("/", (req: Request, res: Response) => {
  res.json({
    name: "Salesforce MCP Web Server",
    version: "1.0.0",
    status: "running",
    endpoints: {
      auth: "/auth",
      callback: "/oauth/callback",
      sse: "/sse",
      status: "/status",
    },
  });
});

// Authentication status
app.get("/status", (req: Request, res: Response) => {
  const userId = (req.session as any).userId;
  const isAuthenticated = userId ? salesforceClient.isAuthenticated(userId) : false;

  res.json({
    authenticated: isAuthenticated,
    userId: userId || null,
  });
});

// Initiate OAuth flow
app.get("/auth", (req: Request, res: Response) => {
  const authUrl = salesforceClient.getAuthorizationUrl();
  res.redirect(authUrl);
});

// OAuth callback
app.get("/oauth/callback", async (req: Request, res: Response) => {
  const { code } = req.query;

  if (!code || typeof code !== "string") {
    return res.status(400).send("Authorization code missing");
  }

  try {
    // Generate or retrieve user ID (in production, use proper user management)
    const userId = (req.session as any).userId || `user_${Date.now()}`;
    (req.session as any).userId = userId;

    // Handle OAuth callback
    await salesforceClient.handleCallback(code, userId);

    res.sendFile(path.join(__dirname, "../public/auth-success.html"));
  } catch (error: any) {
    console.error("OAuth error:", error);
    res.status(500).send(`Authentication failed: ${error.message}`);
  }
});

// Disconnect from Salesforce
app.post("/disconnect", (req: Request, res: Response) => {
  const userId = (req.session as any).userId;
  if (userId) {
    salesforceClient.disconnect(userId);
  }
  req.session.destroy(() => {
    res.json({ success: true, message: "Disconnected from Salesforce" });
  });
});

// MCP Server-Sent Events endpoint
app.get("/sse", async (req: Request, res: Response) => {
  const userId = (req.session as any).userId;

  if (!userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  console.log(`SSE connection established for user: ${userId}`);

  const transport = new SSEServerTransport("/message", res);
  
  // Pass userId to MCP handler through transport metadata
  (transport as any).userId = userId;

  await mcpHandler.getServer().connect(transport);
});

// MCP message endpoint (for POST requests)
app.post("/message", async (req: Request, res: Response) => {
  // This is handled by the SSE transport
  res.status(200).send();
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Salesforce MCP Web Server running on port ${PORT}`);
  console.log(`📝 Base URL: ${process.env.BASE_URL}`);
  console.log(`🔐 Auth URL: ${process.env.BASE_URL}/auth`);
  console.log(`🔌 SSE endpoint: ${process.env.BASE_URL}/sse`);
});
```

### Step 4.4: Success Page (`public/auth-success.html`)

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Salesforce Connected - Claude MCP</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        
        .container {
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            padding: 60px 40px;
            text-align: center;
            max-width: 500px;
            width: 100%;
        }
        
        .success-icon {
            width: 80px;
            height: 80px;
            background: #10b981;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 30px;
            animation: scaleIn 0.5s ease-out;
        }
        
        .success-icon svg {
            width: 50px;
            height: 50px;
            stroke: white;
            stroke-width: 3;
            fill: none;
        }
        
        h1 {
            color: #1f2937;
            font-size: 28px;
            margin-bottom: 16px;
        }
        
        p {
            color: #6b7280;
            font-size: 16px;
            line-height: 1.6;
            margin-bottom: 30px;
        }
        
        .info-box {
            background: #f3f4f6;
            border-radius: 8px;
            padding: 20px;
            margin-top: 30px;
            text-align: left;
        }
        
        .info-box h3 {
            color: #374151;
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 12px;
        }
        
        .info-box ul {
            list-style: none;
            color: #6b7280;
            font-size: 14px;
        }
        
        .info-box li {
            padding: 8px 0;
            padding-left: 24px;
            position: relative;
        }
        
        .info-box li:before {
            content: "✓";
            position: absolute;
            left: 0;
            color: #10b981;
            font-weight: bold;
        }
        
        @keyframes scaleIn {
            from {
                transform: scale(0);
                opacity: 0;
            }
            to {
                transform: scale(1);
                opacity: 1;
            }
        }
        
        .close-btn {
            margin-top: 20px;
            padding: 12px 24px;
            background: #667eea;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.2s;
        }
        
        .close-btn:hover {
            background: #5568d3;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="success-icon">
            <svg viewBox="0 0 24 24">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
        </div>
        
        <h1>Successfully Connected!</h1>
        <p>Your Salesforce account is now connected to Claude. You can close this window and return to claude.ai.</p>
        
        <div class="info-box">
            <h3>What you can do now:</h3>
            <ul>
                <li>Create leads in Salesforce</li>
                <li>Search for existing leads</li>
                <li>Update lead information</li>
                <li>Query Salesforce data</li>
            </ul>
        </div>
        
        <button class="close-btn" onclick="window.close()">Close Window</button>
    </div>
    
    <script>
        // Auto-close after 5 seconds (optional)
        setTimeout(() => {
            window.close();
        }, 5000);
    </script>
</body>
</html>
```

---

## Part 5: Update Configuration Files

### `package.json`

```json
{
  "name": "salesforce-mcp-web-server",
  "version": "1.0.0",
  "type": "module",
  "main": "build/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node build/index.js",
    "dev": "nodemon --exec ts-node src/index.ts",
    "prepare": "npm run build"
  },
  "keywords": ["mcp", "salesforce", "claude"],
  "author": "Your Name",
  "license": "MIT"
}
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "build"]
}
```

### `.gitignore`

```
node_modules/
build/
.env
.DS_Store
*.log
```

---

## Part 6: Build and Deploy

### Step 6.1: Build the Project

```bash
npm run build
```

### Step 6.2: Test Locally with ngrok

```bash
# Install ngrok
npm install -g ngrok

# Start your server
npm run dev

# In another terminal, start ngrok
ngrok http 3000
```

Copy the ngrok HTTPS URL (e.g., `https://abc123.ngrok.io`) and update:
1. `.env` → `BASE_URL` and `SF_CALLBACK_URL`
2. Salesforce Connected App → Callback URL

### Step 6.3: Production Deployment Options

#### Option A: Railway

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Initialize project
railway init

# Add environment variables in Railway dashboard
# Deploy
railway up
```

#### Option B: Heroku

```bash
# Install Heroku CLI
# Create app
heroku create your-app-name

# Set environment variables
heroku config:set SF_CLIENT_ID=your-client-id
heroku config:set SF_CLIENT_SECRET=your-client-secret
heroku config:set SESSION_SECRET=your-secret
# ... set all env vars

# Deploy
git push heroku main
```

#### Option C: DigitalOcean App Platform

1. Connect your GitHub repository
2. Set environment variables in dashboard
3. Deploy automatically

#### Option D: AWS EC2 / VPS

```bash
# SSH into your server
ssh user@your-server-ip

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone your repository
git clone your-repo-url
cd salesforce-mcp-web-server

# Install dependencies
npm install
npm run build

# Install PM2 for process management
npm install -g pm2

# Start server
pm2 start build/index.js --name salesforce-mcp

# Setup nginx reverse proxy with SSL
# (See nginx configuration below)
```

---

## Part 7: Configure Claude.ai

### Step 7.1: Register Your MCP Server

Once deployed, you'll have a public URL like:
- `https://your-app.railway.app`
- `https://your-app.herokuapp.com`
- `https://your-domain.com`

Your MCP Server endpoint will be:
```
https://your-domain.com/sse
```

### Step 7.2: Connect in Claude.ai

**Note**: As of now, claude.ai doesn't have a UI for adding custom MCP servers directly. You need to:

1. **Contact Anthropic** to register your MCP server URL in their directory
2. **Or use the Claude Desktop App** with this configuration:

```json
{
  "mcpServers": {
    "salesforce-web": {
      "url": "https://your-domain.com/sse",
      "transport": "sse"
    }
  }
}
```

### Step 7.3: Authenticate

1. User visits: `https://your-domain.com/auth`
2. Redirects to Salesforce login
3. User authorizes the app
4. Redirects back to success page
5. User can now use Claude with Salesforce tools

---

## Part 8: Usage in Claude

Once connected, users can interact naturally:

```
User: "Create a lead in Salesforce for Jane Doe at Tech Corp, 
       email jane@techcorp.com"

Claude: [Uses create_lead tool]
✅ Lead created successfully for Jane Doe at Tech Corp
Lead ID: 00Q5g000001234ABC
```

```
User: "Search for all leads from Acme company"

Claude: [Uses search_leads tool]
Found 3 leads from Acme:
1. John Smith - CEO - john@acme.com
2. Sarah Johnson - CTO - sarah@acme.com
3. Mike Williams - CFO - mike@acme.com
```

---

## Part 9: Security Best Practices

### 9.1: Environment Variables
- Never commit `.env` to git
- Use secrets management in production (AWS Secrets Manager, etc.)
- Rotate secrets regularly

### 9.2: HTTPS Only
```typescript
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && !req.secure) {
    return res.redirect('https://' + req.headers.host + req.url);
  }
  next();
});
```

### 9.3: Rate Limiting
```bash
npm install express-rate-limit
```

```typescript
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});

app.use('/sse', limiter);
```

### 9.4: User Session Management

For production, implement proper user management:
- User authentication (OAuth, JWT)
- Database for storing user sessions
- Token refresh handling
- Session expiration

---

## Part 10: Monitoring and Debugging

### Logging

```typescript
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple()
  }));
}
```

### Health Checks

```typescript
app.get('/health', async (req, res) => {
  const health = {
    uptime: process.uptime(),
    timestamp: Date.now(),
    status: 'OK',
    salesforce: {
      connected: salesforceClient.isAuthenticated('health-check')
    }
  };
  
  res.json(health);
});
```

---

## Part 11: Advanced Features

### Add More Salesforce Objects

```typescript
// In mcp-handler.ts, add more tools:

{
  name: "create_contact",
  description: "Create a contact in Salesforce",
  inputSchema: {
    type: "object",
    properties: {
      FirstName: { type: "string" },
      LastName: { type: "string" },
      Email: { type: "string" },
      AccountId: { type: "string" }
    },
    required: ["LastName"]
  }
},
{
  name: "create_opportunity",
  description: "Create a sales opportunity",
  inputSchema: {
    type: "object",
    properties: {
      Name: { type: "string" },
      Amount: { type: "number" },
      StageName: { type: "string" },
      CloseDate: { type: "string" }
    },
    required: ["Name", "StageName", "CloseDate"]
  }
}
```

### Webhook Support

```typescript
// Add webhook endpoint for real-time updates
app.post('/webhook/salesforce', async (req, res) => {
  const { event, data } = req.body;
  
  // Process Salesforce events
  console.log('Salesforce event:', event, data);
  
  res.json({ received: true });
});
```

---

## Part 12: Troubleshooting

### Common Issues

**1. "OAuth callback failed"**
- Verify callback URL matches exactly in Salesforce and `.env`
- Check Connected App is activated
- Ensure using HTTPS (not HTTP)

**2. "CORS errors"**
```typescript
app.use(cors({
  origin: ['https://claude.ai', 'https://www.claude.ai'],
  credentials: true
}));
```

**3. "Session not persisting"**
- Check cookie settings (secure: true requires HTTPS)
- Verify SESSION_SECRET is set
- Use Redis for session store in production:

```bash
npm install connect-redis redis
```

```typescript
import RedisStore from 'connect-redis';
import { createClient } from 'redis';

const redisClient = createClient();
redisClient.connect();

app.use(session({
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET!,
  // ...
}));
```

**4. "Tool not found in Claude"**
- Verify SSE endpoint is accessible
- Check server logs for connection errors
- Ensure user is authenticated before using tools

---

## Part 13: Testing

### Test OAuth Flow

```bash
# Visit in browser
https://your-domain.com/auth
```

### Test MCP Connection

```bash
# Use curl to test SSE endpoint
curl -H "Cookie: connect.sid=your-session-id" \
     https://your-domain.com/sse
```

### Test Tool Calls

```bash
# Create a simple test client
cat > test-mcp.js << 'EOF'
import { EventSource } from 'eventsource';

const es = new EventSource('https://your-domain.com/sse');

es.onmessage = (event) => {
  console.log('Message:', event.data);
};

es.onerror = (error) => {
  console.error('Error:', error);
};
EOF

node test-mcp.js
```

---

## Resources

- [MCP Specification](https://spec.modelcontextprotocol.io/)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Salesforce REST API Docs](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/)
- [jsforce Documentation](https://jsforce.github.io/)
- [Express.js Documentation](https://expressjs.com/)

---

## Next Steps

1. ✅ Deploy to production hosting
2. ✅ Get SSL certificate (Let's Encrypt)
3. ✅ Register MCP server URL
4. ✅ Test OAuth flow
5. ✅ Add more Salesforce objects
6. ✅ Implement proper user management
7. ✅ Add monitoring and logging
8. ✅ Set up CI/CD pipeline

You now have a complete web-based MCP server that connects Claude.ai to Salesforce! 🎉
