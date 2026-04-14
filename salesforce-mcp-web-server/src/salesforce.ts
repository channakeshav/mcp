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

    const result: any = await conn.sobject("Lead").create(leadData);

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
