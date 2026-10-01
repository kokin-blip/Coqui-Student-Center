set(EXTRA_PATCHES "")
if (VCPKG_TARGET_IS_WINDOWS AND NOT VCPKG_TARGET_IS_MINGW)
    list(APPEND EXTRA_PATCHES msvc.diff)
endif()

# SourceForge is returning its disaster-recovery page and external mirrors are
# inaccessible from the package runners. Keep the upstream release archive
# beside this overlay and verify it against vcpkg's pinned SHA512 before use.
set(ARCHIVE "${CMAKE_CURRENT_LIST_DIR}/giflib-${VERSION}.tar.gz")
file(SHA512 "${ARCHIVE}" ACTUAL_SHA512)
if (NOT ACTUAL_SHA512 STREQUAL "fb1d6319694745e8cdac7c57e96bd3a87dbfd978f2bfd00e826742db53398011c43f9a6e7f4375b0e77b162358ddfa14d85bce652680fb5967b72c46775c0edb")
    message(FATAL_ERROR "Bundled giflib archive does not match the pinned vcpkg SHA512")
endif()
vcpkg_extract_source_archive(SOURCE_PATH
    ARCHIVE "${ARCHIVE}"
    PATCHES ${EXTRA_PATCHES}
)

file(COPY "${CMAKE_CURRENT_LIST_DIR}/CMakeLists.txt" DESTINATION "${SOURCE_PATH}")

vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    OPTIONS
        "-DGIFLIB_EXPORTS=${CMAKE_CURRENT_LIST_DIR}/exports.def"
    OPTIONS_DEBUG
        -DGIFLIB_SKIP_HEADERS=ON
)

vcpkg_cmake_install()
vcpkg_copy_pdbs()

file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/vcpkg-cmake-wrapper.cmake" DESTINATION "${CURRENT_PACKAGES_DIR}/share/gif")
file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/usage" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/COPYING")
