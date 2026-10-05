#define _GNU_SOURCE
#include <fcntl.h>
#include <inttypes.h>
#include <linux/fs.h>
#include <linux/magic.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/quota.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <unistd.h>

#ifndef PRJQUOTA
#define PRJQUOTA 2
#endif

/* This observer has no provisioning or quota mutation operations. */
int main(int argc, char **argv) {
  if (argc != 3 || argv[1][0] != '/' || argv[2][0] != '/') return 2;
  int directory = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory < 0) { perror("open quota directory"); return 1; }
  struct stat directory_stat, device_stat;
  struct statfs filesystem;
  struct statx extended;
  struct fsxattr project;
  struct dqblk quota;
  struct dqinfo info;
  if (fstat(directory, &directory_stat) || stat(argv[2], &device_stat)
      || !S_ISBLK(device_stat.st_mode) || device_stat.st_rdev != directory_stat.st_dev
      || fstatfs(directory, &filesystem) || filesystem.f_type != EXT4_SUPER_MAGIC
      || statx(directory, "", AT_EMPTY_PATH, STATX_MNT_ID, &extended)
      || ioctl(directory, FS_IOC_FSGETXATTR, &project)
      || quotactl(QCMD(Q_GETINFO, PRJQUOTA), argv[2], 0, (void *)&info)
      || quotactl(QCMD(Q_GETQUOTA, PRJQUOTA), argv[2], project.fsx_projid, (void *)&quota)) {
    perror("read project quota"); close(directory); return 1;
  }
  printf("{\"volumeCapacityBytes\":%" PRIu64 ",\"volumeCapacityInodes\":%" PRIu64 ",\"projectId\":%u,\"inheritance\":%s,\"hardLimitBytes\":%" PRIu64
    ",\"hardInodes\":%" PRIu64 ",\"usedBytes\":%" PRIu64 ",\"usedInodes\":%" PRIu64
    ",\"accountingEnabled\":true,\"filesystem\":{\"device\":\"%" PRIu64
    "\",\"inode\":\"%" PRIu64 "\",\"mountId\":\"%" PRIu64 "\"}}\n",
    (uint64_t)filesystem.f_blocks * filesystem.f_bsize, (uint64_t)filesystem.f_files,
    project.fsx_projid, (project.fsx_xflags & FS_XFLAG_PROJINHERIT) ? "true" : "false",
    (uint64_t)quota.dqb_bhardlimit * 1024, (uint64_t)quota.dqb_ihardlimit,
    (uint64_t)quota.dqb_curspace, (uint64_t)quota.dqb_curinodes,
    (uint64_t)directory_stat.st_dev, (uint64_t)directory_stat.st_ino,
    (uint64_t)extended.stx_mnt_id);
  close(directory);
  return 0;
}
