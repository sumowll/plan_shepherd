This is a comprehensive product that will setup a healthcare plan recommender that get its data from different resources
Patient's data source:
1. patient's providers' EHR fhir systems
2. pateint's payer's patient access api
Payer's data source:
1. provider directory api
2. prior authorization api
Plan selection data:
1. plan finder API (off market non-ACA)
2. marketplace API (ACA QHP)
3. medicare advantage plan list


Front-end:
Input:
a comprehensive UI/UX with the assistant of a chat bot to gather patient information that include:
1. UI has all the required fields but using can chat with AI to help with answers.
2. use AI to help patient with providing the most complete information for their selected/prefered providers. It can use their exisintg provided providers' EHR system or their payer's patient access to list all of their providers that had encounters or claims submitted.
3. If patient has a new health concern or ask for certain sepcialist. AI chat box could help with recommendations for it corresponding taxonomy. 

Output:
1. decide what type of plans does patient qualify? 
Commercial? Medicaid? Medicare? or Medicaid? or Dual? or SNP?
2. which plans satisfy the patients prefered provider selection?
3. The benefits and cost of the plan candidates


backend:
1. a provider system, payer, or insurance type agnostic platform that share modules to connect to the user's selected provider EHR FHIR server, or payer FHIR server. 
2. Government sponsered specific API (marketplace API, plan finder API).
3. modularization and separation of concern for the tech stack


Best practice:
1. HIPPA compliant
2. Application is a web app and will be hosted on Cloudflare
3. best tech stack for stablibility, scalibility and reliability and security
4. Performance optimization and Cost Optimization
5. Deterministic prefered, AI assistance second
6. Use the latest LTS. 

