import { Router } from 'express';
import { wrapRouter } from '../middleware/asyncHandler.js';
import { verifyAuthTokenMiddleware } from '../middleware/auth.js';
import { authRouter } from './authRoutes.js';
import { userRouter } from './userRoutes.js';
import { gigRouter } from './gigRoutes.js';
import { projectRouter } from './projectRoutes.js';
import { proposalRouter } from './proposalRoutes.js';
import orderRouter from './orderRoutes.js';
import workstreamRouter from './workstreamRoutes.js';
import financialRouter from './financialRoutes.js';
import reviewRouter from './reviewRoutes.js';
import notificationRouter from './notificationRoutes.js';
import adminRouter from './adminRoutes.js';

export const apiRouter = Router();
wrapRouter(apiRouter);
apiRouter.use(verifyAuthTokenMiddleware);

apiRouter.use('/auth', wrapRouter(authRouter));
apiRouter.use(wrapRouter(userRouter));
apiRouter.use(wrapRouter(gigRouter));
apiRouter.use(wrapRouter(projectRouter));
apiRouter.use(wrapRouter(proposalRouter));
apiRouter.use(wrapRouter(orderRouter));
apiRouter.use(wrapRouter(workstreamRouter));
apiRouter.use(wrapRouter(financialRouter));
apiRouter.use(wrapRouter(reviewRouter));
apiRouter.use(wrapRouter(notificationRouter));
apiRouter.use(wrapRouter(adminRouter));

export default apiRouter;
