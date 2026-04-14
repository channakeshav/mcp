import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import jsforce from "jsforce";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Salesforce connection - single shared connection
let sfConnection: jsforce.Connection | null = null;

// Initialize Salesforce connection
async function getSalesforceConnection(): Promise<jsforce.Connection> {
  if (sfConnection) {
    return sfConnection;
  }

  const conn = new jsforce.Connection({
    loginUrl: process.env.SF_LOGIN_URL || "https://login.salesforce.com",
  });

  // Login with username + password + security token
  await conn.login(
    process.env.SF_USERNAME!,
    process.env.SF_PASSWORD! // This should be: password + security token
  );

  console.log("✅ Connected to Salesforce");
  console.log("User:", (conn.userInfo as any)?.username);
  
  sfConnection = conn;
  return conn;
}

// Initialize connection on startup
getSalesforceConnection().catch((error) => {
  console.error("❌ Failed to connect to Salesforce:", error.message);
  process.exit(1);
});

// MCP Server Setup
const mcpServer = new Server(
  {
    name: "salesforce-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define tools
const TOOLS: Tool[] = [
  {
    name: "create_lead",
    description:
      "Create a new lead in Salesforce. Required: LastName and Company. Optional: FirstName, Email, Phone, Title, Status, LeadSource, Industry, Description.",
    inputSchema: {
      type: "object",
      properties: {
        FirstName: { type: "string", description: "First name of the lead" },
        LastName: { type: "string", description: "Last name (REQUIRED)" },
        Company: { type: "string", description: "Company name (REQUIRED)" },
        Email: { type: "string", description: "Email address" },
        Phone: { type: "string", description: "Phone number" },
        Title: { type: "string", description: "Job title" },
        Status: {
          type: "string",
          description: "Lead status (default: Open)",
          default: "Open",
        },
        LeadSource: {
          type: "string",
          description: "Lead source (e.g., Web, Referral, Partner)",
        },
        Industry: { type: "string", description: "Industry" },
        Description: { type: "string", description: "Additional notes" },
      },
      required: ["LastName", "Company"],
    },
  },
  {
    name: "search_leads",
    description:
      "Search for leads in Salesforce by name, email, or company name",
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
  {
    name: "get_lead",
    description: "Get details of a specific lead by ID",
    inputSchema: {
      type: "object",
      properties: {
        leadId: {
          type: "string",
          description: "Salesforce Lead ID (e.g., 00Q...)",
        },
      },
      required: ["leadId"],
    },
  },
  {
    name: "update_lead",
    description: "Update an existing lead in Salesforce",
    inputSchema: {
      type: "object",
      properties: {
        leadId: {
          type: "string",
          description: "Salesforce Lead ID to update",
        },
        updates: {
          type: "object",
          description: "Fields to update (e.g., {Status: 'Contacted', Phone: '555-1234'})",
        },
      },
      required: ["leadId", "updates"],
    },
  },
];

// List tools handler
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Handle tool calls
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const conn = await getSalesforceConnection();

    switch (name) {
      case "create_lead":
        return await handleCreateLead(conn, args);

      case "search_leads":
        return await handleSearchLeads(conn, args);

      case "get_lead":
        return await handleGetLead(conn, args);

      case "update_lead":
        return await handleUpdateLead(conn, args);

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    console.error(`Error in ${name}:`, error.message);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Create Lead Handler
async function handleCreateLead(conn: jsforce.Connection, args: any) {
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

  const result: any = await conn.sobject("Lead").create(leadData);

  if (!result.success) {
    throw new Error(`Failed to create lead: ${JSON.stringify(result.errors)}`);
  }

  console.log(`✅ Lead created: ${result.id}`);

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

// Search Leads Handler
async function handleSearchLeads(conn: jsforce.Connection, args: any) {
  const searchTerm = args.searchTerm;
  const limit = args.limit || 10;

  const query = `
    SELECT Id, FirstName, LastName, Company, Email, Phone, Status, 
           LeadSource, CreatedDate
    FROM Lead
    WHERE LastName LIKE '%${searchTerm}%'
       OR FirstName LIKE '%${searchTerm}%'
       OR Company LIKE '%${searchTerm}%'
       OR Email LIKE '%${searchTerm}%'
    ORDER BY CreatedDate DESC
    LIMIT ${limit}
  `;

  const result = await conn.query(query);

  console.log(`🔍 Found ${result.records.length} leads for: ${searchTerm}`);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            success: true,
            count: result.records.length,
            searchTerm: searchTerm,
            leads: result.records,
          },
          null,
          2
        ),
      },
    ],
  };
}

// Get Lead Handler
async function handleGetLead(conn: jsforce.Connection, args: any) {
  const lead = await conn.sobject("Lead").retrieve(args.leadId);

  console.log(`📋 Retrieved lead: ${args.leadId}`);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            success: true,
            lead: lead,
          },
          null,
          2
        ),
      },
    ],
  };
}

// Update Lead Handler
async function handleUpdateLead(conn: jsforce.Connection, args: any) {
  const updateData = {
    Id: args.leadId,
    ...args.updates,
  };

  const result: any = await conn.sobject("Lead").update(updateData);

  if (!result.success) {
    throw new Error(`Failed to update lead: ${JSON.stringify(result.errors)}`);
  }

  console.log(`✏️ Lead updated: ${args.leadId}`);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            success: true,
            leadId: args.leadId,
            message: "Lead updated successfully",
            updates: args.updates,
          },
          null,
          2
        ),
      },
    ],
  };
}

// Express middleware
app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req: Request, res: Response) => {
  res.json({
    name: "Salesforce MCP Server",
    version: "1.0.0",
    status: "running",
    salesforce: {
      connected: sfConnection !== null,
      username: (sfConnection?.userInfo as any)?.username || "Not connected",
    },
    endpoints: {
      sse: "/sse",
      message: "/message",
      health: "/health",
    },
  });
});

// Detailed health check
app.get("/health", async (req: Request, res: Response) => {
  try {
    const conn = await getSalesforceConnection();
    const identity = await conn.identity();

    res.json({
      status: "healthy",
      salesforce: {
        connected: true,
        username: identity.username,
        organizationId: identity.organization_id,
      },
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({
      status: "unhealthy",
      error: error.message,
    });
  }
});

// MCP SSE endpoint
app.get("/sse", async (req: Request, res: Response) => {
  console.log("📡 SSE connection established");

  const transport = new SSEServerTransport("/message", res);
  await mcpServer.connect(transport);
});

// MCP message endpoint
app.post("/message", async (req: Request, res: Response) => {
  // Handled by SSE transport
  res.status(200).send();
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 Salesforce MCP Server Started`);
  console.log(`📍 Port: ${PORT}`);
  console.log(`🌐 URL: http://localhost:${PORT}`);
  console.log(`🔌 SSE: http://localhost:${PORT}/sse`);
  console.log(`💚 Health: http://localhost:${PORT}/health\n`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n👋 Shutting down gracefully...");
  process.exit(0);
});
