package ai.synapse.android;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

/** Background sync about every 30 minutes when the phone has a network. Survives restarts. */
public class SyncJobService extends JobService {
    static final int JOB_ID = 4201;
    private static final long PERIOD_MS = 30L * 60 * 1000;

    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            try {
                Sync.run(getApplicationContext());
            } catch (Exception ignored) {
                // Sync.run already stored the error for the app screen.
            }
            jobFinished(params, false);
        }, "synapse-sync").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true; // retry later
    }

    static void schedule(Context c) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        if (js == null) return;
        JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(c, SyncJobService.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(PERIOD_MS)
                .setPersisted(true)
                .build();
        js.schedule(job);
    }

    static void cancel(Context c) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        if (js != null) js.cancel(JOB_ID);
    }
}
