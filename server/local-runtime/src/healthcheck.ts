const port = process.env.PORT ?? "8787";
const response = await fetch(`http://127.0.0.1:${port}/health/ready`, { headers: { Host: "localhost" } });
if (!response.ok) process.exit(1);
export {};
