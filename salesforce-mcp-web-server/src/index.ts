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
