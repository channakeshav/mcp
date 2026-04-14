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
