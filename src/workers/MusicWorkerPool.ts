import { Worker } from 'worker_threads';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export interface WorkerTask {
    id: string;
    type: 'fetch-song-details' | 'batch-process' | 'verify-song' | 'extract-metadata';
    data: any;
    resolve: (value: any) => void;
    reject: (error: any) => void;
    timestamp: number;
    timeout?: NodeJS.Timeout;
    priority?: 'high' | 'normal' | 'low';
}

export interface WorkerPoolStats {
    totalWorkers: number;
    availableWorkers: number;
    activeWorkers: number;
    queuedTasks: number;
    totalTasksProcessed: number;
    averageTaskTime: number;
    errorRate: number;
}

export class MusicWorkerPool extends EventEmitter {
    private workers: Worker[] = [];
    private availableWorkers: Worker[] = [];
    private taskQueue: WorkerTask[] = [];
    private priorityTaskQueue: WorkerTask[] = []; // High priority tasks
    private workerTasks: Map<Worker, WorkerTask> = new Map();
    private readonly maxWorkers: number;
    private readonly workerScript: string;
    private taskStats: {
        totalProcessed: number;
        totalTime: number;
        errors: number;
    } = { totalProcessed: 0, totalTime: 0, errors: 0 };

    // Task timeout in milliseconds
    private readonly TASK_TIMEOUT = 30000; // 30 seconds

    constructor(maxWorkers?: number) {
        super();
        this.maxWorkers = maxWorkers || Math.min(Math.max(os.cpus().length - 1, 2), 8);
        
        // Determine the correct worker script path based on environment
        // Check multiple possible locations
        const possiblePaths = [
            // Production paths (compiled)
            path.resolve(__dirname, 'musicWorker.js'),
            path.resolve(__dirname, './musicWorker.js'),
            // Development paths (source)
            path.resolve(__dirname, '../workers/musicWorker.ts'),
            path.resolve(__dirname, './musicWorker.ts'),
            // Fallback paths
            path.join(__dirname, 'musicWorker.js'),
            path.join(__dirname, '..', 'workers', 'musicWorker.ts')
        ];
        
        let foundPath = null;
        for (const possiblePath of possiblePaths) {
            if (fs.existsSync(possiblePath)) {
                foundPath = possiblePath;
                break;
            }
        }
        
        if (foundPath) {
            this.workerScript = foundPath;
            console.log(`[WorkerPool] Found worker script: ${this.workerScript}`);
        } else {
            // Last resort - use the most likely production path
            this.workerScript = path.resolve(__dirname, 'musicWorker.js');
            console.error(`[WorkerPool] ❌ Worker script not found in any expected location. Using fallback: ${this.workerScript}`);
            console.error(`[WorkerPool] __dirname: ${__dirname}`);
            console.error(`[WorkerPool] Searched paths:`, possiblePaths);
        }
        
        console.log(`[WorkerPool] Initializing with ${this.maxWorkers} workers`);
        this.initializeWorkers();
    }

    private initializeWorkers(): void {
        for (let i = 0; i < this.maxWorkers; i++) {
            this.createWorker(i);
        }
        console.log(`[WorkerPool] ✅ Initialized ${this.maxWorkers} workers successfully`);
    }

    private createWorker(workerId: number): Worker {
        try {
            console.log(`[WorkerPool] Creating worker ${workerId} with script: ${this.workerScript}`);
            
            // Check if the worker script file exists
            if (!fs.existsSync(this.workerScript)) {
                throw new Error(`Worker script not found: ${this.workerScript}`);
            }
            
            // Check if we're using the compiled version or source version
            const isCompiledVersion = this.workerScript.endsWith('.js');
            
            let worker: Worker;
            if (isCompiledVersion) {
                // Use compiled .js file without ts-node
                console.log(`[WorkerPool] Using compiled worker (no ts-node): ${this.workerScript}`);
                worker = new Worker(this.workerScript, {
                    workerData: { workerId }
                });
            } else {
                // Use TypeScript source file with ts-node
                console.log(`[WorkerPool] Using TypeScript worker (with ts-node): ${this.workerScript}`);
                worker = new Worker(this.workerScript, {
                    workerData: { workerId },
                    execArgv: ['--require', 'ts-node/register']
                });
            }
            
            worker.on('message', (result) => {
                const task = this.workerTasks.get(worker);
                if (task) {
                    this.handleWorkerResponse(worker, task, result);
                }
            });

            worker.on('error', (error) => {
                console.error(`[WorkerPool] ❌ Worker ${workerId} error:`, error);
                this.handleWorkerError(worker, error);
            });

            worker.on('exit', (exitCode) => {
                if (exitCode !== 0) {
                    console.error(`[WorkerPool] ❌ Worker ${workerId} exited with code ${exitCode}`);
                    this.handleWorkerExit(worker);
                }
            });

            this.workers.push(worker);
            this.availableWorkers.push(worker);

            console.log(`[WorkerPool] ✅ Worker ${workerId} created and ready`);
            return worker;
        } catch (error) {
            console.error(`[WorkerPool] ❌ Failed to create worker ${workerId}:`, error);
            console.error(`[WorkerPool] Worker script path: ${this.workerScript}`);
            console.error(`[WorkerPool] __dirname: ${__dirname}`);
            throw error;
        }
    }    private handleWorkerResponse(worker: Worker, task: WorkerTask, result: any): void {
        const processingTime = Date.now() - task.timestamp;
        
        // Clear timeout
        if (task.timeout) {
            clearTimeout(task.timeout);
        }

        // Remove task from worker mapping
        this.workerTasks.delete(worker);
        this.availableWorkers.push(worker);

        // Update statistics
        this.taskStats.totalProcessed++;
        this.taskStats.totalTime += processingTime;

        if (result.success) {
            console.log(`[WorkerPool] ✅ Task ${task.id} completed (${processingTime}ms)`);
            task.resolve(result.data);
        } else {
            console.log(`[WorkerPool] ❌ Task ${task.id} failed: ${result.error} (${processingTime}ms)`);
            this.taskStats.errors++;
            task.reject(new Error(result.error));
        }

        // Process next task in queue
        this.processNextTask();
    }

    private handleWorkerError(worker: Worker, error: Error): void {
        const task = this.workerTasks.get(worker);
        if (task) {
            if (task.timeout) {
                clearTimeout(task.timeout);
            }
            task.reject(error);
            this.workerTasks.delete(worker);
            this.taskStats.errors++;
        }
        
        // Replace failed worker
        this.replaceWorker(worker);
    }

    private handleWorkerExit(worker: Worker): void {
        const task = this.workerTasks.get(worker);
        if (task) {
            if (task.timeout) {
                clearTimeout(task.timeout);
            }
            task.reject(new Error('Worker exited unexpectedly'));
            this.workerTasks.delete(worker);
            this.taskStats.errors++;
        }
        
        // Replace exited worker
        this.replaceWorker(worker);
    }

    private replaceWorker(failedWorker: Worker): void {
        try {
            // Remove from arrays
            const workerIndex = this.workers.indexOf(failedWorker);
            if (workerIndex !== -1) {
                this.workers.splice(workerIndex, 1);
            }
            
            const availableIndex = this.availableWorkers.indexOf(failedWorker);
            if (availableIndex !== -1) {
                this.availableWorkers.splice(availableIndex, 1);
            }

            // Terminate the failed worker
            failedWorker.terminate().catch(console.error);

            // Create replacement
            const newWorkerId = this.workers.length;
            this.createWorker(newWorkerId);
            
            console.log(`[WorkerPool] ✅ Replaced failed worker with new worker ${newWorkerId}`);
        } catch (error) {
            console.error('[WorkerPool] ❌ Error replacing worker:', error);
        }
    }

    private processNextTask(): void {
        if (this.availableWorkers.length === 0) {
            return; // No available workers
        }

        // Process high priority tasks first
        let task = this.priorityTaskQueue.shift();
        if (!task) {
            task = this.taskQueue.shift();
        }

        if (!task) {
            return; // No tasks in queue
        }

        const worker = this.availableWorkers.shift()!;
        this.workerTasks.set(worker, task);

        // Set task timeout
        task.timeout = setTimeout(() => {
            console.log(`[WorkerPool] ⏰ Task ${task!.id} timed out`);
            if (this.workerTasks.has(worker)) {
                this.workerTasks.delete(worker);
                this.taskStats.errors++;
                task!.reject(new Error('Task timeout'));
                
                // Terminate and replace timed out worker
                worker.terminate().catch(console.error);
                this.replaceWorker(worker);
            }
        }, this.TASK_TIMEOUT);

        // Send task to worker
        try {
            worker.postMessage({
                taskId: task.id,
                type: task.type,
                data: task.data
            });
            
            console.log(`[WorkerPool] 🚀 Assigned task ${task.id} to worker`);
        } catch (error) {
            console.error(`[WorkerPool] ❌ Error sending task to worker:`, error);
            if (task.timeout) {
                clearTimeout(task.timeout);
            }
            this.workerTasks.delete(worker);
            this.availableWorkers.push(worker);
            task.reject(error);
        }
    }

    private addTask(task: WorkerTask): void {
        if (task.priority === 'high') {
            this.priorityTaskQueue.push(task);
        } else {
            this.taskQueue.push(task);
        }
        this.processNextTask();
    }

    // Public API Methods

    // Process single song with optional priority
    async processSong(songData: any, priority: 'high' | 'normal' | 'low' = 'normal'): Promise<any> {
        return new Promise((resolve, reject) => {
            const task: WorkerTask = {
                id: `song_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                type: 'fetch-song-details',
                data: songData,
                resolve,
                reject,
                timestamp: Date.now(),
                priority
            };

            this.addTask(task);
        });
    }

    // Process batch of songs with parallel execution
    async processBatch(songs: any[], priority: 'high' | 'normal' | 'low' = 'normal'): Promise<any[]> {
        if (songs.length === 0) {
            return [];
        }

        console.log(`[WorkerPool] 🔄 Processing batch of ${songs.length} songs with ${priority} priority`);
        const startTime = Date.now();
        
        try {
            // Create promises for all songs
            const promises = songs.map((song, index) => 
                this.processSong({
                    ...song,
                    batchIndex: index,
                    batchTotal: songs.length
                }, priority)
            );
            
            // Use Promise.allSettled to handle partial failures
            const results = await Promise.allSettled(promises);
            
            const successful = results
                .filter(result => result.status === 'fulfilled')
                .map(result => (result as PromiseFulfilledResult<any>).value);
            
            const failed = results.filter(result => result.status === 'rejected').length;
            const processingTime = Date.now() - startTime;
            
            console.log(`[WorkerPool] ✅ Batch completed: ${successful.length} successful, ${failed} failed (${processingTime}ms)`);
            
            return successful;
        } catch (error) {
            console.error('[WorkerPool] ❌ Batch processing error:', error);
            throw error;
        }
    }

    // Verify song availability (lightweight check)
    async verifySong(songData: any): Promise<boolean> {
        try {
            const result = await new Promise<any>((resolve, reject) => {
                const task: WorkerTask = {
                    id: `verify_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    type: 'verify-song',
                    data: songData,
                    resolve,
                    reject,
                    timestamp: Date.now(),
                    priority: 'high' // Verification should be fast
                };

                this.addTask(task);
            });

            return result?.available || false;
        } catch (error) {
            console.error('[WorkerPool] ❌ Song verification error:', error);
            return false;
        }
    }

    // Extract metadata without full processing
    async extractMetadata(songData: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const task: WorkerTask = {
                id: `metadata_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                type: 'extract-metadata',
                data: songData,
                resolve,
                reject,
                timestamp: Date.now(),
                priority: 'normal'
            };

            this.addTask(task);
        });
    }

    // Get comprehensive pool statistics
    getStats(): WorkerPoolStats {
        const totalTasks = this.taskStats.totalProcessed;
        return {
            totalWorkers: this.workers.length,
            availableWorkers: this.availableWorkers.length,
            activeWorkers: this.workerTasks.size,
            queuedTasks: this.taskQueue.length + this.priorityTaskQueue.length,
            totalTasksProcessed: totalTasks,
            averageTaskTime: totalTasks > 0 ? this.taskStats.totalTime / totalTasks : 0,
            errorRate: totalTasks > 0 ? (this.taskStats.errors / totalTasks) * 100 : 0
        };
    }

    // Health check
    async healthCheck(): Promise<boolean> {
        try {
            const healthPromises = this.availableWorkers.slice(0, 2).map(worker => 
                new Promise<boolean>((resolve) => {
                    const timeout = setTimeout(() => resolve(false), 5000);
                    
                    const handler = (message: any) => {
                        if (message.type === 'health-check-response') {
                            clearTimeout(timeout);
                            worker.off('message', handler);
                            resolve(true);
                        }
                    };
                    
                    worker.on('message', handler);
                    worker.postMessage({ type: 'health-check' });
                })
            );

            if (healthPromises.length === 0) {
                return this.workers.length > 0; // At least some workers exist
            }

            const results = await Promise.all(healthPromises);
            return results.some(result => result === true);
        } catch (error) {
            console.error('[WorkerPool] ❌ Health check failed:', error);
            return false;
        }
    }

    // Graceful shutdown
    async shutdown(): Promise<void> {
        console.log('[WorkerPool] 🛑 Initiating graceful shutdown...');
        
        try {
            // Stop accepting new tasks
            this.taskQueue.length = 0;
            this.priorityTaskQueue.length = 0;

            // Wait for active tasks to complete (with timeout)
            const activeTaskPromises = Array.from(this.workerTasks.values()).map(task => 
                new Promise<void>((resolve) => {
                    const originalResolve = task.resolve;
                    const originalReject = task.reject;
                    
                    task.resolve = (value) => {
                        originalResolve(value);
                        resolve();
                    };
                    
                    task.reject = (error) => {
                        originalReject(error);
                        resolve();
                    };

                    // Force resolve after timeout
                    setTimeout(resolve, 10000); // 10 second timeout
                })
            );

            if (activeTaskPromises.length > 0) {
                console.log(`[WorkerPool] ⏳ Waiting for ${activeTaskPromises.length} active tasks to complete...`);
                await Promise.all(activeTaskPromises);
            }

            // Terminate all workers
            const terminationPromises = this.workers.map(worker => 
                worker.terminate().catch(error => 
                    console.error('[WorkerPool] ❌ Error terminating worker:', error)
                )
            );

            await Promise.all(terminationPromises);
            
            // Clear arrays
            this.workers.length = 0;
            this.availableWorkers.length = 0;
            this.workerTasks.clear();

            console.log('[WorkerPool] ✅ All workers terminated successfully');
        } catch (error) {
            console.error('[WorkerPool] ❌ Error during shutdown:', error);
            throw error;
        }
    }

    // Scale workers up or down
    async scaleWorkers(targetCount: number): Promise<void> {
        const currentCount = this.workers.length;
        
        if (targetCount === currentCount) {
            return;
        }

        if (targetCount > currentCount) {
            // Scale up
            const addCount = targetCount - currentCount;
            console.log(`[WorkerPool] ⬆️ Scaling up by ${addCount} workers`);
            
            for (let i = 0; i < addCount; i++) {
                this.createWorker(currentCount + i);
            }
        } else {
            // Scale down
            const removeCount = currentCount - targetCount;
            console.log(`[WorkerPool] ⬇️ Scaling down by ${removeCount} workers`);
            
            for (let i = 0; i < removeCount; i++) {
                const worker = this.availableWorkers.pop();
                if (worker) {
                    const index = this.workers.indexOf(worker);
                    if (index !== -1) {
                        this.workers.splice(index, 1);
                    }
                    await worker.terminate();
                }
            }
        }
    }
}
