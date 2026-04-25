# Mission Control deploy workflow

## Tracked deploy SHAs

- `.deploy/backend-sha` — last backend deploy SHA
- `.deploy/frontend-sha` — last frontend deploy SHA

Keep both files committed. Smoke compares each live surface against its own tracked SHA.

## Frontend deploy

1. Make your frontend change.
2. Run:

```bash
npm run deploy-frontend
```

3. Commit the updated `.deploy/frontend-sha` file.

## Backend deploy

1. Push the backend change to `main`.
2. Wait for Render to pick up the deploy.
3. Run:

```bash
npm run record-backend-deploy
```

4. Commit the updated `.deploy/backend-sha` file.

## Smoke

Run:

```bash
npm run smoke
```

The smoke oracle automatically reads `.deploy/backend-sha` and `.deploy/frontend-sha`.
